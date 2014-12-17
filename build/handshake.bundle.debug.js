!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Handshake=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
exports.MESSAGE = 0;
exports.TELL_ADDRESS = 1;
exports.OFFER = 3;
exports.ANSWER = 4;
exports.ERROR_CANNOT_FIND_PEER = 5;
},{}],2:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
var WebRTC = require("webrtc-adapter");
var RTCPeerConnection = WebRTC.RTCPeerConnection;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = require("./address").LocalAddress;
var PeerCache = require("./PeerCache").PeerCache;

var ICE_CONFIG = {"iceServers":[
    {"url":"stun:23.21.150.121"},
    {
        'url': 'turn:192.158.29.39:3478?transport=udp',
        'credential': 'JZEOEt2V3Qb0y27GRntt2u2PAYA=',
        'username': '28224511:1379330808'
    }
]};

var CONN = { 'optional': [{'DtlsSrtpKeyAgreement': true}] };

/**
 *
 * @constructor
 */
function Peer() {
    var pc = new RTCPeerConnection(ICE_CONFIG, CONN);
    this.pc = pc;
    this.address = null;
    this.dc = null;
    this.onOpen = [];
    this.onMessage = [];
    this.onDisconnect = [];
    this.offerCallback = null;
    this.createCallback = null;
    this.iceTimeout = null;
    var self = this;

    this.disconnectCounter = 0; // to prevent "false" positive...
    this.thread = setInterval(function () {
        var i = 0, L = self.onDisconnect.length;
        if (self.dc !== null) {
            if( self.dc.readyState === "closed") {
                if (self.disconnectCounter > 5) {
                    for(;i<L;i++) {
                        self.onDisconnect[i].call(self);
                    }
                    clearInterval(self.thread);
                } else {
                    self.disconnectCounter += 1;
                }
            } else {
                self.disconnectCounter = 0;
            }
        }
    }, 100);

    /**
     * returns the result
     */
    function exec() {
        clearTimeout(self.iceTimeout);
        var d = JSON.stringify(pc.localDescription);
        if (self.offerCallback !== null) {
            self.offerCallback.call(self, d);
            self.offerCallback = null;
        } else if (self.createCallback !== null) {
            self.createCallback.call(self, d);
            self.createCallback = null;
        }
        pc.onicecandidate = null;
    }

    pc.onicecandidate = function (e) {
        if (e.candidate === null) {
            exec();
        } else {
            if (self.iceTimeout !== null) {
                clearTimeout(self.iceTimeout);
            }
            self.iceTimeout = setTimeout(function () {
                exec();
            }, 1000);
        }
    };

    pc.onpeeridentity = function (e) {
        console.log("peer ident:",e);
    }

    pc.onsignalingstatechange = function(ev) {
        console.log("onsignalingstatechange event detected!", ev);
    };
}

Peer.prototype.isOpen = function () {
    if (this.dc !== null) {
        return this.dc.readyState === "open";
    }
    return false;
};

Peer.prototype.disconnect = function () {
    this.dc.close();
};

Peer.prototype.ondisconnect = function (callback) {
    this.onDisconnect.push(callback);
};

Peer.prototype.onopen = function (callback) {
    this.onOpen.push(callback);
};

Peer.prototype.onmessage = function (callback) {
    this.onMessage.push(callback);
};

/**
 * Send any kind of data to the other Peer
 * @param message
 */
Peer.prototype.send = function (message) {
    if (this.dc === null || this.dc.readyState !== "open") {
        throw new Error("Handshake incomplete! Sending is not possible.");
    }
    this.dc.send(JSON.stringify({type: MESSAGE_TYPE.MESSAGE, payload:message }));
};

/**
 * Sends a message without payload
 * @param messageType
 */
Peer.prototype.sendMessageType = function (messageType, payload) {
    if (this.dc === null || this.dc.readyState !== "open") {
        throw new Error("Handshake incomplete! Sending is not possible.");
    }
    if (typeof payload === "undefined") {
        this.dc.send(JSON.stringify({type: messageType }));
    } else {
        this.dc.send(JSON.stringify({type: messageType, payload: payload }));
    }

};

console.log("B " + ADDRESS);

/**
 * Tries to connect to the address through the peer
 * @param address {String}
 * @returns {Peer} resulting peer
 */
Peer.prototype.attemptToConnect = function (address) {
    var self = this;
    var other = createOffer(function (offer) {
        self.sendMessageType(MESSAGE_TYPE.OFFER, {offer:offer, target:address, source:ADDRESS});
    });
    PeerCache.putPending(other, address);
    return other;
};

exports.Peer = Peer;
},{"./MESSAGE_TYPE.js":1,"./PeerCache":3,"./address":4,"webrtc-adapter":6}],3:[function(require,module,exports){
/**
 * Caches connections that are opened and not closed yet for the purpose of signaling
 *
 * Created by Julian on 12/17/2014.
 */

var cache = {};

var pending = {};

exports.PeerCache = {

    /**
     * Put a Peer that is already open
     * @param peer {Peer}
     */
    put: function (peer) {
        if (!peer.isOpen()) throw new Error("Cannot put not-opened peers into cache!");
        if (peer.address in cache) throw new Error("Connection is already open! Cannot put into cache."); //TODO really..?

        cache[peer.address] = peer;

        // Clear when disconnected
        peer.ondisconnect(function () {
            delete cache[peer.address];
        });

        console.log("PeerCache", cache);
    },

    has: function (address) {
        return address in cache;
    },

    get: function (address) {
        return cache[address];
    },

    putPending: function (peer, address) {
        if (peer.isOpen()) throw new Error("Cannot at peer to pending because it is already open!");
        if (address in pending) throw new Error("Connection is already pending! Cannot put into cache."); //TODO really..?

        peer.onopen(function () {
            delete pending[address];
        });
    },

    getPending: function (address) {
        return pending[address];
    }

};

},{}],4:[function(require,module,exports){
/**
 * Created by Julian on 12/17/2014.
 */
var Utils = require("yutils");
exports.LocalAddress = Utils.guid();
},{"yutils":7}],5:[function(require,module,exports){
/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var PeerCache = require("./PeerCache.js").PeerCache;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
//var ADDRESS = Utils.guid(); // pseudo-unique
var ADDRESS = require("./address").LocalAddress;

var onRemoteConnectionCallbacks = [];

/**
 * @type {Object}
 * {
 *      guid1 : peer,
 *      guid2 : peer
 * }
 */

/* ====================================
 A P I
 ==================================== */

/**
 * initiates a Peer-to-Peer connection
 * @param callback
 * @returns {Peer}
 */
function createOffer(callback) {
    var peer = new Peer(), pc = peer.pc;
    peer.offerCallback = callback;

    var dc = pc.createDataChannel("q", {reliable:true});
    pc.createOffer(function (desc) {
        pc.setLocalDescription(desc, function() { });
    }, function failure(e) { console.error(e); });

    dc.onopen = function () {
        dc.send(JSON.stringify({type: MESSAGE_TYPE.TELL_ADDRESS, payload: ADDRESS}));
    };

    dc.onmessage = handleMessage(peer);

    peer.dc = dc;
    return peer;
}

/**
 *
 * @param peer
 * @returns {Function}
 */
function handleMessage(peer) {
    return function (e) {
        var msg = Utils.isString(e.data) ? JSON.parse(e.data) : e.data;
        var i, L, newPeer, destinationPeer;
        switch (msg.type) {
            case MESSAGE_TYPE.OFFER:
                if ("target" in msg.payload) {
                    // we are the mediator
                    if (PeerCache.has(msg.payload.target)) {
                        destinationPeer = PeerCache.get(msg.payload.target);
                        destinationPeer.sendMessageType(MESSAGE_TYPE.OFFER, {offer:msg.payload.offer, source:msg.payload.source});
                    } else {
                        // we cannot establish a connection..
                        peer.sendMessageType(MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER, msg.payload.target);
                    }
                } else {
                    // WE are the TARGET!
                    newPeer = createAnswer(msg.payload, function (answer) {
                        peer.sendMessageType(MESSAGE_TYPE.ANSWER, {answer:answer, source:msg.source, target:ADDRESS});
                    });
                    i = 0, L = onRemoteConnectionCallbacks.length;
                    for(;i<L;i++) {
                        onRemoteConnectionCallbacks[i].call(newPeer,newPeer);
                    }
                }
                break;
            case MESSAGE_TYPE.ANSWER:
                if ("source" in msg.payload) {
                    // we are the mediator..
                    if (PeerCache.has(msg.payload.source)) {
                        destinationPeer = PeerCache.get(msg.payload.source);
                        destinationPeer.sendMessageType(MESSAGE_TYPE.OFFER, {answer:msg.payload.answer, target:msg.payload.target});
                    } else {
                        peer.sendMessageType(MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER, msg.payload.source);
                    }
                } else {
                    // we are the SENDER and we are supposed to apply the answer..
                    destinationPeer = PeerCache.get(msg.payload.target);
                    handleAnswer(destinationPeer, msg.payload.answer);
                }
                break;
            case MESSAGE_TYPE.TELL_ADDRESS:
                peer.address = msg.payload;
                i = 0, L = peer.onOpen.length;
                PeerCache.put(peer);
                for(;i<L;i++) {
                    peer.onOpen[i].call(peer);
                }
                peer.onOpen = null;
                break;
            case MESSAGE_TYPE.MESSAGE:
                i = 0, L = peer.onMessage.length;
                for(;i<L;i++) {
                    peer.onMessage[i].call(peer, msg.payload);
                }
                break;
        }
    };
}

console.log("A " + ADDRESS);

/**
 * Accepts the initial Peer-to-Peer invitation
 * @param offer
 * @param callback
 * @returns {Peer}
 */
function createAnswer(offer, callback) {
    var peer = new Peer(), pc = peer.pc;
    var offerDesc = new RTCSessionDescription(JSON.parse(offer));
    peer.createCallback = callback;
    pc.setRemoteDescription(offerDesc);
    pc.createAnswer(function (answerDesc) {
        pc.setLocalDescription(answerDesc);
    }, function () { console.warn("No create answer"); });

    pc.ondatachannel = function (e) {
        var dc = e.channel || e; // Chrome sends event, FF sends raw channel
        peer.dc = dc;

        dc.onopen = function () {
            dc.send(JSON.stringify({type: MESSAGE_TYPE.TELL_ADDRESS, payload: ADDRESS}));
            // delay open until the response is in
        };

        dc.onmessage = handleMessage(peer);
    };

    return peer;
}

/**
 * Applies the result
 * @param peer
 * @param answer
 */
function handleAnswer(peer, answer) {
    var answerDesc = new RTCSessionDescription(JSON.parse(answer));
    peer.pc.setRemoteDescription(answerDesc);
}

/**
 * We somehow need to notify Bob, that Alice attempts to talk to him!
 * @param callback {function} ({Peer})
 */
function onRemoteConnection(callback) {
    onRemoteConnectionCallbacks.push(callback);
};

/* ====================================
 EXPORT
 ==================================== */
exports.createOffer = createOffer;
exports.handleAnswer = handleAnswer;
exports.createAnswer = createAnswer;
exports.onRemoteConnection = onRemoteConnection;
exports.address = function () {
    return ADDRESS;
};
},{"./MESSAGE_TYPE.js":1,"./Peer.js":2,"./PeerCache.js":3,"./address":4,"yutils":7}],6:[function(require,module,exports){
/*jslint node:true*/
/*globals RTCPeerConnection, mozRTCPeerConnection, webkitRTCPeerConnection */
/*globals RTCSessionDescription, mozRTCSessionDescription */
/*globals RTCIceCandidate, mozRTCIceCandidate */
'use strict';

var myRTCPeerConnection = null;
var myRTCSessionDescription = null;
var myRTCIceCandidate = null;

var renameIceURLs = function (config) {
  if (!config) {
    return;
  }
  if (!config.iceServers) {
    return config;
  }
  config.iceServers.forEach(function (server) {
    server.url = server.urls;
    delete server.urls;
  });
  return config;
};

var fixChromeStatsResponse = function(response) {
  var standardReport = {};
  var reports = response.result();
  reports.forEach(function(report) {
    var standardStats = {
      id: report.id,
      timestamp: report.timestamp,
      type: report.type
    };
    report.names().forEach(function(name) {
      standardStats[name] = report.stat(name);
    });
    standardReport[standardStats.id] = standardStats;
  });

  return standardReport;
};

var sessionHasData = function(desc) {
  if (!desc) {
    return false;
  }
  var hasData = false;
  var prefix = 'm=application';
  desc.sdp.split('\n').forEach(function(line) {
    if (line.slice(0, prefix.length) === prefix) {
      hasData = true;
    }
  });
  return hasData;
};

// Unify PeerConnection Object.
if (typeof RTCPeerConnection !== 'undefined') {
  myRTCPeerConnection = RTCPeerConnection;
} else if (typeof mozRTCPeerConnection !== 'undefined') {
  myRTCPeerConnection = function (configuration, constraints) {
    // Firefox uses 'url' rather than 'urls' for RTCIceServer.urls
    var pc = new mozRTCPeerConnection(renameIceURLs(configuration), constraints);

    // Firefox doesn't fire 'onnegotiationneeded' when a data channel is created
    // https://bugzilla.mozilla.org/show_bug.cgi?id=840728
    var dataEnabled = false;
    var boundCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = function(label, dataChannelDict) {
      var dc = boundCreateDataChannel(label, dataChannelDict);
      if (!dataEnabled) {
        dataEnabled = true;
        if (pc.onnegotiationneeded &&
            !sessionHasData(pc.localDescription) &&
            !sessionHasData(pc.remoteDescription)) {
          var event = new Event('negotiationneeded');
          pc.onnegotiationneeded(event);
        }
      }
      return dc;
    };

    return pc;
  };
} else if (typeof webkitRTCPeerConnection !== 'undefined') {
  // Chrome returns a nonstandard, non-JSON-ifiable response from getStats.
  myRTCPeerConnection = function(configuration, constraints) {
    var pc = new webkitRTCPeerConnection(configuration, constraints);
    var boundGetStats = pc.getStats.bind(pc);
    pc.getStats = function(selector, successCallback, failureCallback) {
      var successCallbackWrapper = function(chromeStatsResponse) {
        successCallback(fixChromeStatsResponse(chromeStatsResponse));
      };
      // Chrome also takes its arguments in the wrong order.
      boundGetStats(successCallbackWrapper, failureCallback, selector);
    };
    return pc;
  };
}

// Unify SessionDescrption Object.
if (typeof RTCSessionDescription !== 'undefined') {
  myRTCSessionDescription = RTCSessionDescription;
} else if (typeof mozRTCSessionDescription !== 'undefined') {
  myRTCSessionDescription = mozRTCSessionDescription;
}

// Unify IceCandidate Object.
if (typeof RTCIceCandidate !== 'undefined') {
  myRTCIceCandidate = RTCIceCandidate;
} else if (typeof mozRTCIceCandidate !== 'undefined') {
  myRTCIceCandidate = mozRTCIceCandidate;
}

exports.RTCPeerConnection = myRTCPeerConnection;
exports.RTCSessionDescription = myRTCSessionDescription;
exports.RTCIceCandidate = myRTCIceCandidate;

},{}],7:[function(require,module,exports){
/**
 * Created by Julian on 12/10/2014.
 */
(function (exports) {

    // performance.now polyfill
    var perf = null;
    if (typeof performance === 'undefined') {
        perf = {};
    } else {
        perf = performance;
    }

    perf.now = perf.now || perf.mozNow || perf.msNow ||  perf.oNow || perf.webkitNow || Date.now ||
        function () {
            return new Date().getTime();
        };

    function swap(array, i, j) {
        if (i !== j) {
            var temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
    }

    /*
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     */

    var getRandomInt = exports.getRandomInt = function (min, max) {
        if (min > max) throw new Error("min must be smaller than max! {" + min + ">" + max + "}" );
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    exports.sample = function (list, n) {
        var result = [], j,i = 0, L = n > list.length ? list.length : n, s = list.length - 1;
        for(;i<L;i++) {
            j = getRandomInt(i,s);
            swap(list,i,j);
            result.push(list[i]);
        }
        return result;
    };

    exports.isString = function(myVar) {
        return (typeof myVar === 'string' || myVar instanceof String)
    };

    exports.assertLength = function (arg, nbr) {
        if (arg.length === nbr) return true;
        else throw new Error("Wrong number of arguments: expected:" + nbr + ", but got: " + arg.length);
    };

    exports.guid = function () {
        var d = perf.now();
        var guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (d + Math.random() * 16) % 16 | 0;
            d = Math.floor(d / 16);
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        return guid;
    };

})(typeof exports === 'undefined' ? this['yUtils'] = {} : exports);
},{}]},{},[5])(5)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkM6XFxVc2Vyc1xcQmFrYVxcQXBwRGF0YVxcUm9hbWluZ1xcbnBtXFxub2RlX21vZHVsZXNcXGJyb3dzZXJpZnlcXG5vZGVfbW9kdWxlc1xcYnJvd3Nlci1wYWNrXFxfcHJlbHVkZS5qcyIsImxpYlxcTUVTU0FHRV9UWVBFLmpzIiwibGliXFxQZWVyLmpzIiwibGliXFxQZWVyQ2FjaGUuanMiLCJsaWJcXGFkZHJlc3MuanMiLCJsaWJcXGhhbmRzaGFrZS5qcyIsIm5vZGVfbW9kdWxlc1xcd2VicnRjLWFkYXB0ZXJcXGFkYXB0ZXIuanMiLCJub2RlX21vZHVsZXNcXHl1dGlsc1xceXV0aWxzLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BEQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ0pBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUtBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBIiwiZmlsZSI6ImdlbmVyYXRlZC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3ZhciBmPW5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIik7dGhyb3cgZi5jb2RlPVwiTU9EVUxFX05PVF9GT1VORFwiLGZ9dmFyIGw9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGwuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sbCxsLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xNi8yMDE0LlxyXG4gKi9cclxuZXhwb3J0cy5NRVNTQUdFID0gMDtcclxuZXhwb3J0cy5URUxMX0FERFJFU1MgPSAxO1xyXG5leHBvcnRzLk9GRkVSID0gMztcclxuZXhwb3J0cy5BTlNXRVIgPSA0O1xyXG5leHBvcnRzLkVSUk9SX0NBTk5PVF9GSU5EX1BFRVIgPSA1OyIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xNi8yMDE0LlxyXG4gKi9cclxudmFyIFdlYlJUQyA9IHJlcXVpcmUoXCJ3ZWJydGMtYWRhcHRlclwiKTtcclxudmFyIFJUQ1BlZXJDb25uZWN0aW9uID0gV2ViUlRDLlJUQ1BlZXJDb25uZWN0aW9uO1xyXG52YXIgTUVTU0FHRV9UWVBFID0gcmVxdWlyZShcIi4vTUVTU0FHRV9UWVBFLmpzXCIpO1xyXG52YXIgQUREUkVTUyA9IHJlcXVpcmUoXCIuL2FkZHJlc3NcIikuTG9jYWxBZGRyZXNzO1xyXG52YXIgUGVlckNhY2hlID0gcmVxdWlyZShcIi4vUGVlckNhY2hlXCIpLlBlZXJDYWNoZTtcclxuXHJcbnZhciBJQ0VfQ09ORklHID0ge1wiaWNlU2VydmVyc1wiOltcclxuICAgIHtcInVybFwiOlwic3R1bjoyMy4yMS4xNTAuMTIxXCJ9LFxyXG4gICAge1xyXG4gICAgICAgICd1cmwnOiAndHVybjoxOTIuMTU4LjI5LjM5OjM0Nzg/dHJhbnNwb3J0PXVkcCcsXHJcbiAgICAgICAgJ2NyZWRlbnRpYWwnOiAnSlpFT0V0MlYzUWIweTI3R1JudHQydTJQQVlBPScsXHJcbiAgICAgICAgJ3VzZXJuYW1lJzogJzI4MjI0NTExOjEzNzkzMzA4MDgnXHJcbiAgICB9XHJcbl19O1xyXG5cclxudmFyIENPTk4gPSB7ICdvcHRpb25hbCc6IFt7J0R0bHNTcnRwS2V5QWdyZWVtZW50JzogdHJ1ZX1dIH07XHJcblxyXG4vKipcclxuICpcclxuICogQGNvbnN0cnVjdG9yXHJcbiAqL1xyXG5mdW5jdGlvbiBQZWVyKCkge1xyXG4gICAgdmFyIHBjID0gbmV3IFJUQ1BlZXJDb25uZWN0aW9uKElDRV9DT05GSUcsIENPTk4pO1xyXG4gICAgdGhpcy5wYyA9IHBjO1xyXG4gICAgdGhpcy5hZGRyZXNzID0gbnVsbDtcclxuICAgIHRoaXMuZGMgPSBudWxsO1xyXG4gICAgdGhpcy5vbk9wZW4gPSBbXTtcclxuICAgIHRoaXMub25NZXNzYWdlID0gW107XHJcbiAgICB0aGlzLm9uRGlzY29ubmVjdCA9IFtdO1xyXG4gICAgdGhpcy5vZmZlckNhbGxiYWNrID0gbnVsbDtcclxuICAgIHRoaXMuY3JlYXRlQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgdGhpcy5pY2VUaW1lb3V0ID0gbnVsbDtcclxuICAgIHZhciBzZWxmID0gdGhpcztcclxuXHJcbiAgICB0aGlzLmRpc2Nvbm5lY3RDb3VudGVyID0gMDsgLy8gdG8gcHJldmVudCBcImZhbHNlXCIgcG9zaXRpdmUuLi5cclxuICAgIHRoaXMudGhyZWFkID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHZhciBpID0gMCwgTCA9IHNlbGYub25EaXNjb25uZWN0Lmxlbmd0aDtcclxuICAgICAgICBpZiAoc2VsZi5kYyAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBpZiggc2VsZi5kYy5yZWFkeVN0YXRlID09PSBcImNsb3NlZFwiKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2VsZi5kaXNjb25uZWN0Q291bnRlciA+IDUpIHtcclxuICAgICAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5vbkRpc2Nvbm5lY3RbaV0uY2FsbChzZWxmKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJJbnRlcnZhbChzZWxmLnRocmVhZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHNlbGYuZGlzY29ubmVjdENvdW50ZXIgKz0gMTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNlbGYuZGlzY29ubmVjdENvdW50ZXIgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSwgMTAwKTtcclxuXHJcbiAgICAvKipcclxuICAgICAqIHJldHVybnMgdGhlIHJlc3VsdFxyXG4gICAgICovXHJcbiAgICBmdW5jdGlvbiBleGVjKCkge1xyXG4gICAgICAgIGNsZWFyVGltZW91dChzZWxmLmljZVRpbWVvdXQpO1xyXG4gICAgICAgIHZhciBkID0gSlNPTi5zdHJpbmdpZnkocGMubG9jYWxEZXNjcmlwdGlvbik7XHJcbiAgICAgICAgaWYgKHNlbGYub2ZmZXJDYWxsYmFjayAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBzZWxmLm9mZmVyQ2FsbGJhY2suY2FsbChzZWxmLCBkKTtcclxuICAgICAgICAgICAgc2VsZi5vZmZlckNhbGxiYWNrID0gbnVsbDtcclxuICAgICAgICB9IGVsc2UgaWYgKHNlbGYuY3JlYXRlQ2FsbGJhY2sgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgc2VsZi5jcmVhdGVDYWxsYmFjay5jYWxsKHNlbGYsIGQpO1xyXG4gICAgICAgICAgICBzZWxmLmNyZWF0ZUNhbGxiYWNrID0gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgcGMub25pY2VjYW5kaWRhdGUgPSBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHBjLm9uaWNlY2FuZGlkYXRlID0gZnVuY3Rpb24gKGUpIHtcclxuICAgICAgICBpZiAoZS5jYW5kaWRhdGUgPT09IG51bGwpIHtcclxuICAgICAgICAgICAgZXhlYygpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgIGlmIChzZWxmLmljZVRpbWVvdXQgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChzZWxmLmljZVRpbWVvdXQpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHNlbGYuaWNlVGltZW91dCA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICAgICAgZXhlYygpO1xyXG4gICAgICAgICAgICB9LCAxMDAwKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG5cclxuICAgIHBjLm9ucGVlcmlkZW50aXR5ID0gZnVuY3Rpb24gKGUpIHtcclxuICAgICAgICBjb25zb2xlLmxvZyhcInBlZXIgaWRlbnQ6XCIsZSk7XHJcbiAgICB9XHJcblxyXG4gICAgcGMub25zaWduYWxpbmdzdGF0ZWNoYW5nZSA9IGZ1bmN0aW9uKGV2KSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJvbnNpZ25hbGluZ3N0YXRlY2hhbmdlIGV2ZW50IGRldGVjdGVkIVwiLCBldik7XHJcbiAgICB9O1xyXG59XHJcblxyXG5QZWVyLnByb3RvdHlwZS5pc09wZW4gPSBmdW5jdGlvbiAoKSB7XHJcbiAgICBpZiAodGhpcy5kYyAhPT0gbnVsbCkge1xyXG4gICAgICAgIHJldHVybiB0aGlzLmRjLnJlYWR5U3RhdGUgPT09IFwib3BlblwiO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUuZGlzY29ubmVjdCA9IGZ1bmN0aW9uICgpIHtcclxuICAgIHRoaXMuZGMuY2xvc2UoKTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLm9uZGlzY29ubmVjdCA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbkRpc2Nvbm5lY3QucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5vbm9wZW4gPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcclxuICAgIHRoaXMub25PcGVuLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25tZXNzYWdlID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XHJcbiAgICB0aGlzLm9uTWVzc2FnZS5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBTZW5kIGFueSBraW5kIG9mIGRhdGEgdG8gdGhlIG90aGVyIFBlZXJcclxuICogQHBhcmFtIG1lc3NhZ2VcclxuICovXHJcblBlZXIucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbiAobWVzc2FnZSkge1xyXG4gICAgaWYgKHRoaXMuZGMgPT09IG51bGwgfHwgdGhpcy5kYy5yZWFkeVN0YXRlICE9PSBcIm9wZW5cIikge1xyXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkhhbmRzaGFrZSBpbmNvbXBsZXRlISBTZW5kaW5nIGlzIG5vdCBwb3NzaWJsZS5cIik7XHJcbiAgICB9XHJcbiAgICB0aGlzLmRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IE1FU1NBR0VfVFlQRS5NRVNTQUdFLCBwYXlsb2FkOm1lc3NhZ2UgfSkpO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFNlbmRzIGEgbWVzc2FnZSB3aXRob3V0IHBheWxvYWRcclxuICogQHBhcmFtIG1lc3NhZ2VUeXBlXHJcbiAqL1xyXG5QZWVyLnByb3RvdHlwZS5zZW5kTWVzc2FnZVR5cGUgPSBmdW5jdGlvbiAobWVzc2FnZVR5cGUsIHBheWxvYWQpIHtcclxuICAgIGlmICh0aGlzLmRjID09PSBudWxsIHx8IHRoaXMuZGMucmVhZHlTdGF0ZSAhPT0gXCJvcGVuXCIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJIYW5kc2hha2UgaW5jb21wbGV0ZSEgU2VuZGluZyBpcyBub3QgcG9zc2libGUuXCIpO1xyXG4gICAgfVxyXG4gICAgaWYgKHR5cGVvZiBwYXlsb2FkID09PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgdGhpcy5kYy5zZW5kKEpTT04uc3RyaW5naWZ5KHt0eXBlOiBtZXNzYWdlVHlwZSB9KSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogbWVzc2FnZVR5cGUsIHBheWxvYWQ6IHBheWxvYWQgfSkpO1xyXG4gICAgfVxyXG5cclxufTtcclxuXHJcbmNvbnNvbGUubG9nKFwiQiBcIiArIEFERFJFU1MpO1xyXG5cclxuLyoqXHJcbiAqIFRyaWVzIHRvIGNvbm5lY3QgdG8gdGhlIGFkZHJlc3MgdGhyb3VnaCB0aGUgcGVlclxyXG4gKiBAcGFyYW0gYWRkcmVzcyB7U3RyaW5nfVxyXG4gKiBAcmV0dXJucyB7UGVlcn0gcmVzdWx0aW5nIHBlZXJcclxuICovXHJcblBlZXIucHJvdG90eXBlLmF0dGVtcHRUb0Nvbm5lY3QgPSBmdW5jdGlvbiAoYWRkcmVzcykge1xyXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gICAgdmFyIG90aGVyID0gY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKG9mZmVyKSB7XHJcbiAgICAgICAgc2VsZi5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLk9GRkVSLCB7b2ZmZXI6b2ZmZXIsIHRhcmdldDphZGRyZXNzLCBzb3VyY2U6QUREUkVTU30pO1xyXG4gICAgfSk7XHJcbiAgICBQZWVyQ2FjaGUucHV0UGVuZGluZyhvdGhlciwgYWRkcmVzcyk7XHJcbiAgICByZXR1cm4gb3RoZXI7XHJcbn07XHJcblxyXG5leHBvcnRzLlBlZXIgPSBQZWVyOyIsIi8qKlxyXG4gKiBDYWNoZXMgY29ubmVjdGlvbnMgdGhhdCBhcmUgb3BlbmVkIGFuZCBub3QgY2xvc2VkIHlldCBmb3IgdGhlIHB1cnBvc2Ugb2Ygc2lnbmFsaW5nXHJcbiAqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzE3LzIwMTQuXHJcbiAqL1xyXG5cclxudmFyIGNhY2hlID0ge307XHJcblxyXG52YXIgcGVuZGluZyA9IHt9O1xyXG5cclxuZXhwb3J0cy5QZWVyQ2FjaGUgPSB7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBQdXQgYSBQZWVyIHRoYXQgaXMgYWxyZWFkeSBvcGVuXHJcbiAgICAgKiBAcGFyYW0gcGVlciB7UGVlcn1cclxuICAgICAqL1xyXG4gICAgcHV0OiBmdW5jdGlvbiAocGVlcikge1xyXG4gICAgICAgIGlmICghcGVlci5pc09wZW4oKSkgdGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IHB1dCBub3Qtb3BlbmVkIHBlZXJzIGludG8gY2FjaGUhXCIpO1xyXG4gICAgICAgIGlmIChwZWVyLmFkZHJlc3MgaW4gY2FjaGUpIHRocm93IG5ldyBFcnJvcihcIkNvbm5lY3Rpb24gaXMgYWxyZWFkeSBvcGVuISBDYW5ub3QgcHV0IGludG8gY2FjaGUuXCIpOyAvL1RPRE8gcmVhbGx5Li4/XHJcblxyXG4gICAgICAgIGNhY2hlW3BlZXIuYWRkcmVzc10gPSBwZWVyO1xyXG5cclxuICAgICAgICAvLyBDbGVhciB3aGVuIGRpc2Nvbm5lY3RlZFxyXG4gICAgICAgIHBlZXIub25kaXNjb25uZWN0KGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGNhY2hlW3BlZXIuYWRkcmVzc107XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGNvbnNvbGUubG9nKFwiUGVlckNhY2hlXCIsIGNhY2hlKTtcclxuICAgIH0sXHJcblxyXG4gICAgaGFzOiBmdW5jdGlvbiAoYWRkcmVzcykge1xyXG4gICAgICAgIHJldHVybiBhZGRyZXNzIGluIGNhY2hlO1xyXG4gICAgfSxcclxuXHJcbiAgICBnZXQ6IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICAgICAgcmV0dXJuIGNhY2hlW2FkZHJlc3NdO1xyXG4gICAgfSxcclxuXHJcbiAgICBwdXRQZW5kaW5nOiBmdW5jdGlvbiAocGVlciwgYWRkcmVzcykge1xyXG4gICAgICAgIGlmIChwZWVyLmlzT3BlbigpKSB0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgYXQgcGVlciB0byBwZW5kaW5nIGJlY2F1c2UgaXQgaXMgYWxyZWFkeSBvcGVuIVwiKTtcclxuICAgICAgICBpZiAoYWRkcmVzcyBpbiBwZW5kaW5nKSB0aHJvdyBuZXcgRXJyb3IoXCJDb25uZWN0aW9uIGlzIGFscmVhZHkgcGVuZGluZyEgQ2Fubm90IHB1dCBpbnRvIGNhY2hlLlwiKTsgLy9UT0RPIHJlYWxseS4uP1xyXG5cclxuICAgICAgICBwZWVyLm9ub3BlbihmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIGRlbGV0ZSBwZW5kaW5nW2FkZHJlc3NdO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfSxcclxuXHJcbiAgICBnZXRQZW5kaW5nOiBmdW5jdGlvbiAoYWRkcmVzcykge1xyXG4gICAgICAgIHJldHVybiBwZW5kaW5nW2FkZHJlc3NdO1xyXG4gICAgfVxyXG5cclxufTtcclxuIiwiLyoqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzE3LzIwMTQuXHJcbiAqL1xyXG52YXIgVXRpbHMgPSByZXF1aXJlKFwieXV0aWxzXCIpO1xyXG5leHBvcnRzLkxvY2FsQWRkcmVzcyA9IFV0aWxzLmd1aWQoKTsiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTEvMjAxNC5cclxuICovXHJcbnZhciBVdGlscyA9IHJlcXVpcmUoXCJ5dXRpbHNcIik7XHJcbnZhciBQZWVyID0gcmVxdWlyZShcIi4vUGVlci5qc1wiKS5QZWVyO1xyXG52YXIgUGVlckNhY2hlID0gcmVxdWlyZShcIi4vUGVlckNhY2hlLmpzXCIpLlBlZXJDYWNoZTtcclxudmFyIE1FU1NBR0VfVFlQRSA9IHJlcXVpcmUoXCIuL01FU1NBR0VfVFlQRS5qc1wiKTtcclxuLy92YXIgQUREUkVTUyA9IFV0aWxzLmd1aWQoKTsgLy8gcHNldWRvLXVuaXF1ZVxyXG52YXIgQUREUkVTUyA9IHJlcXVpcmUoXCIuL2FkZHJlc3NcIikuTG9jYWxBZGRyZXNzO1xyXG5cclxudmFyIG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrcyA9IFtdO1xyXG5cclxuLyoqXHJcbiAqIEB0eXBlIHtPYmplY3R9XHJcbiAqIHtcclxuICogICAgICBndWlkMSA6IHBlZXIsXHJcbiAqICAgICAgZ3VpZDIgOiBwZWVyXHJcbiAqIH1cclxuICovXHJcblxyXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuIEEgUCBJXHJcbiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cclxuXHJcbi8qKlxyXG4gKiBpbml0aWF0ZXMgYSBQZWVyLXRvLVBlZXIgY29ubmVjdGlvblxyXG4gKiBAcGFyYW0gY2FsbGJhY2tcclxuICogQHJldHVybnMge1BlZXJ9XHJcbiAqL1xyXG5mdW5jdGlvbiBjcmVhdGVPZmZlcihjYWxsYmFjaykge1xyXG4gICAgdmFyIHBlZXIgPSBuZXcgUGVlcigpLCBwYyA9IHBlZXIucGM7XHJcbiAgICBwZWVyLm9mZmVyQ2FsbGJhY2sgPSBjYWxsYmFjaztcclxuXHJcbiAgICB2YXIgZGMgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbChcInFcIiwge3JlbGlhYmxlOnRydWV9KTtcclxuICAgIHBjLmNyZWF0ZU9mZmVyKGZ1bmN0aW9uIChkZXNjKSB7XHJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihkZXNjLCBmdW5jdGlvbigpIHsgfSk7XHJcbiAgICB9LCBmdW5jdGlvbiBmYWlsdXJlKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfSk7XHJcblxyXG4gICAgZGMub25vcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIGRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IE1FU1NBR0VfVFlQRS5URUxMX0FERFJFU1MsIHBheWxvYWQ6IEFERFJFU1N9KSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGRjLm9ubWVzc2FnZSA9IGhhbmRsZU1lc3NhZ2UocGVlcik7XHJcblxyXG4gICAgcGVlci5kYyA9IGRjO1xyXG4gICAgcmV0dXJuIHBlZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKlxyXG4gKiBAcGFyYW0gcGVlclxyXG4gKiBAcmV0dXJucyB7RnVuY3Rpb259XHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVNZXNzYWdlKHBlZXIpIHtcclxuICAgIHJldHVybiBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIHZhciBtc2cgPSBVdGlscy5pc1N0cmluZyhlLmRhdGEpID8gSlNPTi5wYXJzZShlLmRhdGEpIDogZS5kYXRhO1xyXG4gICAgICAgIHZhciBpLCBMLCBuZXdQZWVyLCBkZXN0aW5hdGlvblBlZXI7XHJcbiAgICAgICAgc3dpdGNoIChtc2cudHlwZSkge1xyXG4gICAgICAgICAgICBjYXNlIE1FU1NBR0VfVFlQRS5PRkZFUjpcclxuICAgICAgICAgICAgICAgIGlmIChcInRhcmdldFwiIGluIG1zZy5wYXlsb2FkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gd2UgYXJlIHRoZSBtZWRpYXRvclxyXG4gICAgICAgICAgICAgICAgICAgIGlmIChQZWVyQ2FjaGUuaGFzKG1zZy5wYXlsb2FkLnRhcmdldCkpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdGluYXRpb25QZWVyID0gUGVlckNhY2hlLmdldChtc2cucGF5bG9hZC50YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0aW5hdGlvblBlZXIuc2VuZE1lc3NhZ2VUeXBlKE1FU1NBR0VfVFlQRS5PRkZFUiwge29mZmVyOm1zZy5wYXlsb2FkLm9mZmVyLCBzb3VyY2U6bXNnLnBheWxvYWQuc291cmNlfSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gd2UgY2Fubm90IGVzdGFibGlzaCBhIGNvbm5lY3Rpb24uLlxyXG4gICAgICAgICAgICAgICAgICAgICAgICBwZWVyLnNlbmRNZXNzYWdlVHlwZShNRVNTQUdFX1RZUEUuRVJST1JfQ0FOTk9UX0ZJTkRfUEVFUiwgbXNnLnBheWxvYWQudGFyZ2V0KTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIFdFIGFyZSB0aGUgVEFSR0VUIVxyXG4gICAgICAgICAgICAgICAgICAgIG5ld1BlZXIgPSBjcmVhdGVBbnN3ZXIobXNnLnBheWxvYWQsIGZ1bmN0aW9uIChhbnN3ZXIpIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGVlci5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLkFOU1dFUiwge2Fuc3dlcjphbnN3ZXIsIHNvdXJjZTptc2cuc291cmNlLCB0YXJnZXQ6QUREUkVTU30pO1xyXG4gICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIGkgPSAwLCBMID0gb25SZW1vdGVDb25uZWN0aW9uQ2FsbGJhY2tzLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgb25SZW1vdGVDb25uZWN0aW9uQ2FsbGJhY2tzW2ldLmNhbGwobmV3UGVlcixuZXdQZWVyKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuQU5TV0VSOlxyXG4gICAgICAgICAgICAgICAgaWYgKFwic291cmNlXCIgaW4gbXNnLnBheWxvYWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyB3ZSBhcmUgdGhlIG1lZGlhdG9yLi5cclxuICAgICAgICAgICAgICAgICAgICBpZiAoUGVlckNhY2hlLmhhcyhtc2cucGF5bG9hZC5zb3VyY2UpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlciA9IFBlZXJDYWNoZS5nZXQobXNnLnBheWxvYWQuc291cmNlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdGluYXRpb25QZWVyLnNlbmRNZXNzYWdlVHlwZShNRVNTQUdFX1RZUEUuT0ZGRVIsIHthbnN3ZXI6bXNnLnBheWxvYWQuYW5zd2VyLCB0YXJnZXQ6bXNnLnBheWxvYWQudGFyZ2V0fSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgcGVlci5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLkVSUk9SX0NBTk5PVF9GSU5EX1BFRVIsIG1zZy5wYXlsb2FkLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyB3ZSBhcmUgdGhlIFNFTkRFUiBhbmQgd2UgYXJlIHN1cHBvc2VkIHRvIGFwcGx5IHRoZSBhbnN3ZXIuLlxyXG4gICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlciA9IFBlZXJDYWNoZS5nZXQobXNnLnBheWxvYWQudGFyZ2V0KTtcclxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVBbnN3ZXIoZGVzdGluYXRpb25QZWVyLCBtc2cucGF5bG9hZC5hbnN3ZXIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUzpcclxuICAgICAgICAgICAgICAgIHBlZXIuYWRkcmVzcyA9IG1zZy5wYXlsb2FkO1xyXG4gICAgICAgICAgICAgICAgaSA9IDAsIEwgPSBwZWVyLm9uT3Blbi5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICBQZWVyQ2FjaGUucHV0KHBlZXIpO1xyXG4gICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcGVlci5vbk9wZW5baV0uY2FsbChwZWVyKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHBlZXIub25PcGVuID0gbnVsbDtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIE1FU1NBR0VfVFlQRS5NRVNTQUdFOlxyXG4gICAgICAgICAgICAgICAgaSA9IDAsIEwgPSBwZWVyLm9uTWVzc2FnZS5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICBwZWVyLm9uTWVzc2FnZVtpXS5jYWxsKHBlZXIsIG1zZy5wYXlsb2FkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbn1cclxuXHJcbmNvbnNvbGUubG9nKFwiQSBcIiArIEFERFJFU1MpO1xyXG5cclxuLyoqXHJcbiAqIEFjY2VwdHMgdGhlIGluaXRpYWwgUGVlci10by1QZWVyIGludml0YXRpb25cclxuICogQHBhcmFtIG9mZmVyXHJcbiAqIEBwYXJhbSBjYWxsYmFja1xyXG4gKiBAcmV0dXJucyB7UGVlcn1cclxuICovXHJcbmZ1bmN0aW9uIGNyZWF0ZUFuc3dlcihvZmZlciwgY2FsbGJhY2spIHtcclxuICAgIHZhciBwZWVyID0gbmV3IFBlZXIoKSwgcGMgPSBwZWVyLnBjO1xyXG4gICAgdmFyIG9mZmVyRGVzYyA9IG5ldyBSVENTZXNzaW9uRGVzY3JpcHRpb24oSlNPTi5wYXJzZShvZmZlcikpO1xyXG4gICAgcGVlci5jcmVhdGVDYWxsYmFjayA9IGNhbGxiYWNrO1xyXG4gICAgcGMuc2V0UmVtb3RlRGVzY3JpcHRpb24ob2ZmZXJEZXNjKTtcclxuICAgIHBjLmNyZWF0ZUFuc3dlcihmdW5jdGlvbiAoYW5zd2VyRGVzYykge1xyXG4gICAgICAgIHBjLnNldExvY2FsRGVzY3JpcHRpb24oYW5zd2VyRGVzYyk7XHJcbiAgICB9LCBmdW5jdGlvbiAoKSB7IGNvbnNvbGUud2FybihcIk5vIGNyZWF0ZSBhbnN3ZXJcIik7IH0pO1xyXG5cclxuICAgIHBjLm9uZGF0YWNoYW5uZWwgPSBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIHZhciBkYyA9IGUuY2hhbm5lbCB8fCBlOyAvLyBDaHJvbWUgc2VuZHMgZXZlbnQsIEZGIHNlbmRzIHJhdyBjaGFubmVsXHJcbiAgICAgICAgcGVlci5kYyA9IGRjO1xyXG5cclxuICAgICAgICBkYy5vbm9wZW4gPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIGRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IE1FU1NBR0VfVFlQRS5URUxMX0FERFJFU1MsIHBheWxvYWQ6IEFERFJFU1N9KSk7XHJcbiAgICAgICAgICAgIC8vIGRlbGF5IG9wZW4gdW50aWwgdGhlIHJlc3BvbnNlIGlzIGluXHJcbiAgICAgICAgfTtcclxuXHJcbiAgICAgICAgZGMub25tZXNzYWdlID0gaGFuZGxlTWVzc2FnZShwZWVyKTtcclxuICAgIH07XHJcblxyXG4gICAgcmV0dXJuIHBlZXI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBcHBsaWVzIHRoZSByZXN1bHRcclxuICogQHBhcmFtIHBlZXJcclxuICogQHBhcmFtIGFuc3dlclxyXG4gKi9cclxuZnVuY3Rpb24gaGFuZGxlQW5zd2VyKHBlZXIsIGFuc3dlcikge1xyXG4gICAgdmFyIGFuc3dlckRlc2MgPSBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKEpTT04ucGFyc2UoYW5zd2VyKSk7XHJcbiAgICBwZWVyLnBjLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlckRlc2MpO1xyXG59XHJcblxyXG4vKipcclxuICogV2Ugc29tZWhvdyBuZWVkIHRvIG5vdGlmeSBCb2IsIHRoYXQgQWxpY2UgYXR0ZW1wdHMgdG8gdGFsayB0byBoaW0hXHJcbiAqIEBwYXJhbSBjYWxsYmFjayB7ZnVuY3Rpb259ICh7UGVlcn0pXHJcbiAqL1xyXG5mdW5jdGlvbiBvblJlbW90ZUNvbm5lY3Rpb24oY2FsbGJhY2spIHtcclxuICAgIG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrcy5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gRVhQT1JUXHJcbiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cclxuZXhwb3J0cy5jcmVhdGVPZmZlciA9IGNyZWF0ZU9mZmVyO1xyXG5leHBvcnRzLmhhbmRsZUFuc3dlciA9IGhhbmRsZUFuc3dlcjtcclxuZXhwb3J0cy5jcmVhdGVBbnN3ZXIgPSBjcmVhdGVBbnN3ZXI7XHJcbmV4cG9ydHMub25SZW1vdGVDb25uZWN0aW9uID0gb25SZW1vdGVDb25uZWN0aW9uO1xyXG5leHBvcnRzLmFkZHJlc3MgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICByZXR1cm4gQUREUkVTUztcclxufTsiLCIvKmpzbGludCBub2RlOnRydWUqL1xuLypnbG9iYWxzIFJUQ1BlZXJDb25uZWN0aW9uLCBtb3pSVENQZWVyQ29ubmVjdGlvbiwgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24gKi9cbi8qZ2xvYmFscyBSVENTZXNzaW9uRGVzY3JpcHRpb24sIG1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAqL1xuLypnbG9iYWxzIFJUQ0ljZUNhbmRpZGF0ZSwgbW96UlRDSWNlQ2FuZGlkYXRlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBteVJUQ1BlZXJDb25uZWN0aW9uID0gbnVsbDtcbnZhciBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG51bGw7XG52YXIgbXlSVENJY2VDYW5kaWRhdGUgPSBudWxsO1xuXG52YXIgcmVuYW1lSWNlVVJMcyA9IGZ1bmN0aW9uIChjb25maWcpIHtcbiAgaWYgKCFjb25maWcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFjb25maWcuaWNlU2VydmVycykge1xuICAgIHJldHVybiBjb25maWc7XG4gIH1cbiAgY29uZmlnLmljZVNlcnZlcnMuZm9yRWFjaChmdW5jdGlvbiAoc2VydmVyKSB7XG4gICAgc2VydmVyLnVybCA9IHNlcnZlci51cmxzO1xuICAgIGRlbGV0ZSBzZXJ2ZXIudXJscztcbiAgfSk7XG4gIHJldHVybiBjb25maWc7XG59O1xuXG52YXIgZml4Q2hyb21lU3RhdHNSZXNwb25zZSA9IGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gIHZhciBzdGFuZGFyZFJlcG9ydCA9IHt9O1xuICB2YXIgcmVwb3J0cyA9IHJlc3BvbnNlLnJlc3VsdCgpO1xuICByZXBvcnRzLmZvckVhY2goZnVuY3Rpb24ocmVwb3J0KSB7XG4gICAgdmFyIHN0YW5kYXJkU3RhdHMgPSB7XG4gICAgICBpZDogcmVwb3J0LmlkLFxuICAgICAgdGltZXN0YW1wOiByZXBvcnQudGltZXN0YW1wLFxuICAgICAgdHlwZTogcmVwb3J0LnR5cGVcbiAgICB9O1xuICAgIHJlcG9ydC5uYW1lcygpLmZvckVhY2goZnVuY3Rpb24obmFtZSkge1xuICAgICAgc3RhbmRhcmRTdGF0c1tuYW1lXSA9IHJlcG9ydC5zdGF0KG5hbWUpO1xuICAgIH0pO1xuICAgIHN0YW5kYXJkUmVwb3J0W3N0YW5kYXJkU3RhdHMuaWRdID0gc3RhbmRhcmRTdGF0cztcbiAgfSk7XG5cbiAgcmV0dXJuIHN0YW5kYXJkUmVwb3J0O1xufTtcblxudmFyIHNlc3Npb25IYXNEYXRhID0gZnVuY3Rpb24oZGVzYykge1xuICBpZiAoIWRlc2MpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdmFyIGhhc0RhdGEgPSBmYWxzZTtcbiAgdmFyIHByZWZpeCA9ICdtPWFwcGxpY2F0aW9uJztcbiAgZGVzYy5zZHAuc3BsaXQoJ1xcbicpLmZvckVhY2goZnVuY3Rpb24obGluZSkge1xuICAgIGlmIChsaW5lLnNsaWNlKDAsIHByZWZpeC5sZW5ndGgpID09PSBwcmVmaXgpIHtcbiAgICAgIGhhc0RhdGEgPSB0cnVlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBoYXNEYXRhO1xufTtcblxuLy8gVW5pZnkgUGVlckNvbm5lY3Rpb24gT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENQZWVyQ29ubmVjdGlvbiA9IFJUQ1BlZXJDb25uZWN0aW9uO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDUGVlckNvbm5lY3Rpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDUGVlckNvbm5lY3Rpb24gPSBmdW5jdGlvbiAoY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICAvLyBGaXJlZm94IHVzZXMgJ3VybCcgcmF0aGVyIHRoYW4gJ3VybHMnIGZvciBSVENJY2VTZXJ2ZXIudXJsc1xuICAgIHZhciBwYyA9IG5ldyBtb3pSVENQZWVyQ29ubmVjdGlvbihyZW5hbWVJY2VVUkxzKGNvbmZpZ3VyYXRpb24pLCBjb25zdHJhaW50cyk7XG5cbiAgICAvLyBGaXJlZm94IGRvZXNuJ3QgZmlyZSAnb25uZWdvdGlhdGlvbm5lZWRlZCcgd2hlbiBhIGRhdGEgY2hhbm5lbCBpcyBjcmVhdGVkXG4gICAgLy8gaHR0cHM6Ly9idWd6aWxsYS5tb3ppbGxhLm9yZy9zaG93X2J1Zy5jZ2k/aWQ9ODQwNzI4XG4gICAgdmFyIGRhdGFFbmFibGVkID0gZmFsc2U7XG4gICAgdmFyIGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbC5iaW5kKHBjKTtcbiAgICBwYy5jcmVhdGVEYXRhQ2hhbm5lbCA9IGZ1bmN0aW9uKGxhYmVsLCBkYXRhQ2hhbm5lbERpY3QpIHtcbiAgICAgIHZhciBkYyA9IGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGRhdGFDaGFubmVsRGljdCk7XG4gICAgICBpZiAoIWRhdGFFbmFibGVkKSB7XG4gICAgICAgIGRhdGFFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKHBjLm9ubmVnb3RpYXRpb25uZWVkZWQgJiZcbiAgICAgICAgICAgICFzZXNzaW9uSGFzRGF0YShwYy5sb2NhbERlc2NyaXB0aW9uKSAmJlxuICAgICAgICAgICAgIXNlc3Npb25IYXNEYXRhKHBjLnJlbW90ZURlc2NyaXB0aW9uKSkge1xuICAgICAgICAgIHZhciBldmVudCA9IG5ldyBFdmVudCgnbmVnb3RpYXRpb25uZWVkZWQnKTtcbiAgICAgICAgICBwYy5vbm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGRjO1xuICAgIH07XG5cbiAgICByZXR1cm4gcGM7XG4gIH07XG59IGVsc2UgaWYgKHR5cGVvZiB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgLy8gQ2hyb21lIHJldHVybnMgYSBub25zdGFuZGFyZCwgbm9uLUpTT04taWZpYWJsZSByZXNwb25zZSBmcm9tIGdldFN0YXRzLlxuICBteVJUQ1BlZXJDb25uZWN0aW9uID0gZnVuY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICB2YXIgcGMgPSBuZXcgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpO1xuICAgIHZhciBib3VuZEdldFN0YXRzID0gcGMuZ2V0U3RhdHMuYmluZChwYyk7XG4gICAgcGMuZ2V0U3RhdHMgPSBmdW5jdGlvbihzZWxlY3Rvciwgc3VjY2Vzc0NhbGxiYWNrLCBmYWlsdXJlQ2FsbGJhY2spIHtcbiAgICAgIHZhciBzdWNjZXNzQ2FsbGJhY2tXcmFwcGVyID0gZnVuY3Rpb24oY2hyb21lU3RhdHNSZXNwb25zZSkge1xuICAgICAgICBzdWNjZXNzQ2FsbGJhY2soZml4Q2hyb21lU3RhdHNSZXNwb25zZShjaHJvbWVTdGF0c1Jlc3BvbnNlKSk7XG4gICAgICB9O1xuICAgICAgLy8gQ2hyb21lIGFsc28gdGFrZXMgaXRzIGFyZ3VtZW50cyBpbiB0aGUgd3Jvbmcgb3JkZXIuXG4gICAgICBib3VuZEdldFN0YXRzKHN1Y2Nlc3NDYWxsYmFja1dyYXBwZXIsIGZhaWx1cmVDYWxsYmFjaywgc2VsZWN0b3IpO1xuICAgIH07XG4gICAgcmV0dXJuIHBjO1xuICB9O1xufVxuXG4vLyBVbmlmeSBTZXNzaW9uRGVzY3JwdGlvbiBPYmplY3QuXG5pZiAodHlwZW9mIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENTZXNzaW9uRGVzY3JpcHRpb24gPSBSVENTZXNzaW9uRGVzY3JpcHRpb247XG59IGVsc2UgaWYgKHR5cGVvZiBtb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gbW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xufVxuXG4vLyBVbmlmeSBJY2VDYW5kaWRhdGUgT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENJY2VDYW5kaWRhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDSWNlQ2FuZGlkYXRlID0gUlRDSWNlQ2FuZGlkYXRlO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDSWNlQ2FuZGlkYXRlICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ0ljZUNhbmRpZGF0ZSA9IG1velJUQ0ljZUNhbmRpZGF0ZTtcbn1cblxuZXhwb3J0cy5SVENQZWVyQ29ubmVjdGlvbiA9IG15UlRDUGVlckNvbm5lY3Rpb247XG5leHBvcnRzLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xuZXhwb3J0cy5SVENJY2VDYW5kaWRhdGUgPSBteVJUQ0ljZUNhbmRpZGF0ZTtcbiIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xMC8yMDE0LlxyXG4gKi9cclxuKGZ1bmN0aW9uIChleHBvcnRzKSB7XHJcblxyXG4gICAgLy8gcGVyZm9ybWFuY2Uubm93IHBvbHlmaWxsXHJcbiAgICB2YXIgcGVyZiA9IG51bGw7XHJcbiAgICBpZiAodHlwZW9mIHBlcmZvcm1hbmNlID09PSAndW5kZWZpbmVkJykge1xyXG4gICAgICAgIHBlcmYgPSB7fTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcGVyZiA9IHBlcmZvcm1hbmNlO1xyXG4gICAgfVxyXG5cclxuICAgIHBlcmYubm93ID0gcGVyZi5ub3cgfHwgcGVyZi5tb3pOb3cgfHwgcGVyZi5tc05vdyB8fCAgcGVyZi5vTm93IHx8IHBlcmYud2Via2l0Tm93IHx8IERhdGUubm93IHx8XHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBzd2FwKGFycmF5LCBpLCBqKSB7XHJcbiAgICAgICAgaWYgKGkgIT09IGopIHtcclxuICAgICAgICAgICAgdmFyIHRlbXAgPSBhcnJheVtpXTtcclxuICAgICAgICAgICAgYXJyYXlbaV0gPSBhcnJheVtqXTtcclxuICAgICAgICAgICAgYXJyYXlbal0gPSB0ZW1wO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKlxyXG4gICAgfn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5cclxuICAgICAqL1xyXG5cclxuICAgIHZhciBnZXRSYW5kb21JbnQgPSBleHBvcnRzLmdldFJhbmRvbUludCA9IGZ1bmN0aW9uIChtaW4sIG1heCkge1xyXG4gICAgICAgIGlmIChtaW4gPiBtYXgpIHRocm93IG5ldyBFcnJvcihcIm1pbiBtdXN0IGJlIHNtYWxsZXIgdGhhbiBtYXghIHtcIiArIG1pbiArIFwiPlwiICsgbWF4ICsgXCJ9XCIgKTtcclxuICAgICAgICByZXR1cm4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKG1heCAtIG1pbiArIDEpKSArIG1pbjtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5zYW1wbGUgPSBmdW5jdGlvbiAobGlzdCwgbikge1xyXG4gICAgICAgIHZhciByZXN1bHQgPSBbXSwgaixpID0gMCwgTCA9IG4gPiBsaXN0Lmxlbmd0aCA/IGxpc3QubGVuZ3RoIDogbiwgcyA9IGxpc3QubGVuZ3RoIC0gMTtcclxuICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgaiA9IGdldFJhbmRvbUludChpLHMpO1xyXG4gICAgICAgICAgICBzd2FwKGxpc3QsaSxqKTtcclxuICAgICAgICAgICAgcmVzdWx0LnB1c2gobGlzdFtpXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuaXNTdHJpbmcgPSBmdW5jdGlvbihteVZhcikge1xyXG4gICAgICAgIHJldHVybiAodHlwZW9mIG15VmFyID09PSAnc3RyaW5nJyB8fCBteVZhciBpbnN0YW5jZW9mIFN0cmluZylcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5hc3NlcnRMZW5ndGggPSBmdW5jdGlvbiAoYXJnLCBuYnIpIHtcclxuICAgICAgICBpZiAoYXJnLmxlbmd0aCA9PT0gbmJyKSByZXR1cm4gdHJ1ZTtcclxuICAgICAgICBlbHNlIHRocm93IG5ldyBFcnJvcihcIldyb25nIG51bWJlciBvZiBhcmd1bWVudHM6IGV4cGVjdGVkOlwiICsgbmJyICsgXCIsIGJ1dCBnb3Q6IFwiICsgYXJnLmxlbmd0aCk7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuZ3VpZCA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICB2YXIgZCA9IHBlcmYubm93KCk7XHJcbiAgICAgICAgdmFyIGd1aWQgPSAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uIChjKSB7XHJcbiAgICAgICAgICAgIHZhciByID0gKGQgKyBNYXRoLnJhbmRvbSgpICogMTYpICUgMTYgfCAwO1xyXG4gICAgICAgICAgICBkID0gTWF0aC5mbG9vcihkIC8gMTYpO1xyXG4gICAgICAgICAgICByZXR1cm4gKGMgPT09ICd4JyA/IHIgOiAociAmIDB4MyB8IDB4OCkpLnRvU3RyaW5nKDE2KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4gZ3VpZDtcclxuICAgIH07XHJcblxyXG59KSh0eXBlb2YgZXhwb3J0cyA9PT0gJ3VuZGVmaW5lZCcgPyB0aGlzWyd5VXRpbHMnXSA9IHt9IDogZXhwb3J0cyk7Il19
