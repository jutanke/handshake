!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Handshake=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Created by Julian on 12/17/2014.
 */
var Utils = require("yutils");
exports.LocalAddress = Utils.guid();
},{"yutils":7}],2:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
exports.MESSAGE = 0;
exports.TELL_ADDRESS = 1;
exports.OFFER = 3;
exports.ANSWER = 4;
exports.ERROR_CANNOT_FIND_PEER = 5;
},{}],3:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
var WebRTC = require("webrtc-adapter");
var RTCPeerConnection = WebRTC.RTCPeerConnection;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = require("./Address").LocalAddress;
var PeerCache = require("./PeerCache").PeerCache;
var Handshake = require("./handshake.js");

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

    /*
    pc.onpeeridentity = function (e) {
        //console.log("peer ident:",e);
    }

    pc.onsignalingstatechange = function(ev) {
        //console.log("onsignalingstatechange event detected!", ev);
    };
    */
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

/**
 * Tries to connect to the address through the peer
 * @param address {String}
 * @returns {Peer} resulting peer
 */
Peer.prototype.attemptToConnect = function (address) {
    var self = this;
    var other = Handshake.createOffer(function (offer) {
        self.sendMessageType(MESSAGE_TYPE.OFFER, {offer:offer, target:address, source:ADDRESS});
    });
    PeerCache.putPending(other, address);
    return other;
};

exports.Peer = Peer;
},{"./Address":1,"./MESSAGE_TYPE.js":2,"./PeerCache":4,"./handshake.js":5,"webrtc-adapter":6}],4:[function(require,module,exports){
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

        pending[address] = peer;
    },

    getPending: function (address) {
        return pending[address];
    }

};

},{}],5:[function(require,module,exports){
/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var PeerCache = require("./PeerCache.js").PeerCache;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
//var ADDRESS = Utils.guid(); // pseudo-unique
var ADDRESS = require("./Address").LocalAddress;

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
                    newPeer = createAnswer(msg.payload.offer, function (answer) {
                        peer.sendMessageType(
                            MESSAGE_TYPE.ANSWER, {
                                answer: answer,
                                source: msg.payload.source,
                                target: ADDRESS
                            }
                        );
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
                        destinationPeer.sendMessageType(MESSAGE_TYPE.ANSWER, {
                            answer: msg.payload.answer,
                            target: msg.payload.target
                        });
                    } else {
                        peer.sendMessageType(MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER, msg.payload.target);
                    }
                } else {
                    // we are the SENDER and we are supposed to apply the answer..
                    destinationPeer = PeerCache.getPending(msg.payload.target);
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
},{"./Address":1,"./MESSAGE_TYPE.js":2,"./Peer.js":3,"./PeerCache.js":4,"yutils":7}],6:[function(require,module,exports){
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkM6XFxVc2Vyc1xcQmFrYVxcQXBwRGF0YVxcUm9hbWluZ1xcbnBtXFxub2RlX21vZHVsZXNcXGJyb3dzZXJpZnlcXG5vZGVfbW9kdWxlc1xcYnJvd3Nlci1wYWNrXFxfcHJlbHVkZS5qcyIsImxpYlxcQWRkcmVzcy5qcyIsImxpYlxcTUVTU0FHRV9UWVBFLmpzIiwibGliXFxQZWVyLmpzIiwibGliXFxQZWVyQ2FjaGUuanMiLCJsaWJcXGhhbmRzaGFrZS5qcyIsIm5vZGVfbW9kdWxlc1xcd2VicnRjLWFkYXB0ZXJcXGFkYXB0ZXIuanMiLCJub2RlX21vZHVsZXNcXHl1dGlsc1xceXV0aWxzLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNKQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ1BBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNqS0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNuTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbiBlKHQsbixyKXtmdW5jdGlvbiBzKG8sdSl7aWYoIW5bb10pe2lmKCF0W29dKXt2YXIgYT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2lmKCF1JiZhKXJldHVybiBhKG8sITApO2lmKGkpcmV0dXJuIGkobywhMCk7dmFyIGY9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitvK1wiJ1wiKTt0aHJvdyBmLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsZn12YXIgbD1uW29dPXtleHBvcnRzOnt9fTt0W29dWzBdLmNhbGwobC5leHBvcnRzLGZ1bmN0aW9uKGUpe3ZhciBuPXRbb11bMV1bZV07cmV0dXJuIHMobj9uOmUpfSxsLGwuZXhwb3J0cyxlLHQsbixyKX1yZXR1cm4gbltvXS5leHBvcnRzfXZhciBpPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7Zm9yKHZhciBvPTA7bzxyLmxlbmd0aDtvKyspcyhyW29dKTtyZXR1cm4gc30pIiwiLyoqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzE3LzIwMTQuXHJcbiAqL1xyXG52YXIgVXRpbHMgPSByZXF1aXJlKFwieXV0aWxzXCIpO1xyXG5leHBvcnRzLkxvY2FsQWRkcmVzcyA9IFV0aWxzLmd1aWQoKTsiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTYvMjAxNC5cclxuICovXHJcbmV4cG9ydHMuTUVTU0FHRSA9IDA7XHJcbmV4cG9ydHMuVEVMTF9BRERSRVNTID0gMTtcclxuZXhwb3J0cy5PRkZFUiA9IDM7XHJcbmV4cG9ydHMuQU5TV0VSID0gNDtcclxuZXhwb3J0cy5FUlJPUl9DQU5OT1RfRklORF9QRUVSID0gNTsiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTYvMjAxNC5cclxuICovXHJcbnZhciBXZWJSVEMgPSByZXF1aXJlKFwid2VicnRjLWFkYXB0ZXJcIik7XHJcbnZhciBSVENQZWVyQ29ubmVjdGlvbiA9IFdlYlJUQy5SVENQZWVyQ29ubmVjdGlvbjtcclxudmFyIE1FU1NBR0VfVFlQRSA9IHJlcXVpcmUoXCIuL01FU1NBR0VfVFlQRS5qc1wiKTtcclxudmFyIEFERFJFU1MgPSByZXF1aXJlKFwiLi9BZGRyZXNzXCIpLkxvY2FsQWRkcmVzcztcclxudmFyIFBlZXJDYWNoZSA9IHJlcXVpcmUoXCIuL1BlZXJDYWNoZVwiKS5QZWVyQ2FjaGU7XHJcbnZhciBIYW5kc2hha2UgPSByZXF1aXJlKFwiLi9oYW5kc2hha2UuanNcIik7XHJcblxyXG52YXIgSUNFX0NPTkZJRyA9IHtcImljZVNlcnZlcnNcIjpbXHJcbiAgICB7XCJ1cmxcIjpcInN0dW46MjMuMjEuMTUwLjEyMVwifSxcclxuICAgIHtcclxuICAgICAgICAndXJsJzogJ3R1cm46MTkyLjE1OC4yOS4zOTozNDc4P3RyYW5zcG9ydD11ZHAnLFxyXG4gICAgICAgICdjcmVkZW50aWFsJzogJ0paRU9FdDJWM1FiMHkyN0dSbnR0MnUyUEFZQT0nLFxyXG4gICAgICAgICd1c2VybmFtZSc6ICcyODIyNDUxMToxMzc5MzMwODA4J1xyXG4gICAgfVxyXG5dfTtcclxuXHJcbnZhciBDT05OID0geyAnb3B0aW9uYWwnOiBbeydEdGxzU3J0cEtleUFncmVlbWVudCc6IHRydWV9XSB9O1xyXG5cclxuLyoqXHJcbiAqXHJcbiAqIEBjb25zdHJ1Y3RvclxyXG4gKi9cclxuZnVuY3Rpb24gUGVlcigpIHtcclxuICAgIHZhciBwYyA9IG5ldyBSVENQZWVyQ29ubmVjdGlvbihJQ0VfQ09ORklHLCBDT05OKTtcclxuICAgIHRoaXMucGMgPSBwYztcclxuICAgIHRoaXMuYWRkcmVzcyA9IG51bGw7XHJcbiAgICB0aGlzLmRjID0gbnVsbDtcclxuICAgIHRoaXMub25PcGVuID0gW107XHJcbiAgICB0aGlzLm9uTWVzc2FnZSA9IFtdO1xyXG4gICAgdGhpcy5vbkRpc2Nvbm5lY3QgPSBbXTtcclxuICAgIHRoaXMub2ZmZXJDYWxsYmFjayA9IG51bGw7XHJcbiAgICB0aGlzLmNyZWF0ZUNhbGxiYWNrID0gbnVsbDtcclxuICAgIHRoaXMuaWNlVGltZW91dCA9IG51bGw7XHJcbiAgICB2YXIgc2VsZiA9IHRoaXM7XHJcblxyXG4gICAgdGhpcy5kaXNjb25uZWN0Q291bnRlciA9IDA7IC8vIHRvIHByZXZlbnQgXCJmYWxzZVwiIHBvc2l0aXZlLi4uXHJcbiAgICB0aGlzLnRocmVhZCA9IHNldEludGVydmFsKGZ1bmN0aW9uICgpIHtcclxuICAgICAgICB2YXIgaSA9IDAsIEwgPSBzZWxmLm9uRGlzY29ubmVjdC5sZW5ndGg7XHJcbiAgICAgICAgaWYgKHNlbGYuZGMgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgaWYoIHNlbGYuZGMucmVhZHlTdGF0ZSA9PT0gXCJjbG9zZWRcIikge1xyXG4gICAgICAgICAgICAgICAgaWYgKHNlbGYuZGlzY29ubmVjdENvdW50ZXIgPiA1KSB7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHNlbGYub25EaXNjb25uZWN0W2ldLmNhbGwoc2VsZik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgICAgIGNsZWFySW50ZXJ2YWwoc2VsZi50aHJlYWQpO1xyXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICBzZWxmLmRpc2Nvbm5lY3RDb3VudGVyICs9IDE7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICBzZWxmLmRpc2Nvbm5lY3RDb3VudGVyID0gMDtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0sIDEwMCk7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiByZXR1cm5zIHRoZSByZXN1bHRcclxuICAgICAqL1xyXG4gICAgZnVuY3Rpb24gZXhlYygpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoc2VsZi5pY2VUaW1lb3V0KTtcclxuICAgICAgICB2YXIgZCA9IEpTT04uc3RyaW5naWZ5KHBjLmxvY2FsRGVzY3JpcHRpb24pO1xyXG4gICAgICAgIGlmIChzZWxmLm9mZmVyQ2FsbGJhY2sgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgc2VsZi5vZmZlckNhbGxiYWNrLmNhbGwoc2VsZiwgZCk7XHJcbiAgICAgICAgICAgIHNlbGYub2ZmZXJDYWxsYmFjayA9IG51bGw7XHJcbiAgICAgICAgfSBlbHNlIGlmIChzZWxmLmNyZWF0ZUNhbGxiYWNrICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIHNlbGYuY3JlYXRlQ2FsbGJhY2suY2FsbChzZWxmLCBkKTtcclxuICAgICAgICAgICAgc2VsZi5jcmVhdGVDYWxsYmFjayA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHBjLm9uaWNlY2FuZGlkYXRlID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBwYy5vbmljZWNhbmRpZGF0ZSA9IGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgaWYgKGUuY2FuZGlkYXRlID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgIGV4ZWMoKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBpZiAoc2VsZi5pY2VUaW1lb3V0ICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoc2VsZi5pY2VUaW1lb3V0KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxmLmljZVRpbWVvdXQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgICAgIGV4ZWMoKTtcclxuICAgICAgICAgICAgfSwgMTAwMCk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICAvKlxyXG4gICAgcGMub25wZWVyaWRlbnRpdHkgPSBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIC8vY29uc29sZS5sb2coXCJwZWVyIGlkZW50OlwiLGUpO1xyXG4gICAgfVxyXG5cclxuICAgIHBjLm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgPSBmdW5jdGlvbihldikge1xyXG4gICAgICAgIC8vY29uc29sZS5sb2coXCJvbnNpZ25hbGluZ3N0YXRlY2hhbmdlIGV2ZW50IGRldGVjdGVkIVwiLCBldik7XHJcbiAgICB9O1xyXG4gICAgKi9cclxufVxyXG5cclxuUGVlci5wcm90b3R5cGUuaXNPcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgaWYgKHRoaXMuZGMgIT09IG51bGwpIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5kYy5yZWFkeVN0YXRlID09PSBcIm9wZW5cIjtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLmRpc2Nvbm5lY3QgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICB0aGlzLmRjLmNsb3NlKCk7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5vbmRpc2Nvbm5lY3QgPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcclxuICAgIHRoaXMub25EaXNjb25uZWN0LnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25vcGVuID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XHJcbiAgICB0aGlzLm9uT3Blbi5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLm9ubWVzc2FnZSA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbk1lc3NhZ2UucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKipcclxuICogU2VuZCBhbnkga2luZCBvZiBkYXRhIHRvIHRoZSBvdGhlciBQZWVyXHJcbiAqIEBwYXJhbSBtZXNzYWdlXHJcbiAqL1xyXG5QZWVyLnByb3RvdHlwZS5zZW5kID0gZnVuY3Rpb24gKG1lc3NhZ2UpIHtcclxuICAgIGlmICh0aGlzLmRjID09PSBudWxsIHx8IHRoaXMuZGMucmVhZHlTdGF0ZSAhPT0gXCJvcGVuXCIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJIYW5kc2hha2UgaW5jb21wbGV0ZSEgU2VuZGluZyBpcyBub3QgcG9zc2libGUuXCIpO1xyXG4gICAgfVxyXG4gICAgdGhpcy5kYy5zZW5kKEpTT04uc3RyaW5naWZ5KHt0eXBlOiBNRVNTQUdFX1RZUEUuTUVTU0FHRSwgcGF5bG9hZDptZXNzYWdlIH0pKTtcclxufTtcclxuXHJcbi8qKlxyXG4gKiBTZW5kcyBhIG1lc3NhZ2Ugd2l0aG91dCBwYXlsb2FkXHJcbiAqIEBwYXJhbSBtZXNzYWdlVHlwZVxyXG4gKi9cclxuUGVlci5wcm90b3R5cGUuc2VuZE1lc3NhZ2VUeXBlID0gZnVuY3Rpb24gKG1lc3NhZ2VUeXBlLCBwYXlsb2FkKSB7XHJcbiAgICBpZiAodGhpcy5kYyA9PT0gbnVsbCB8fCB0aGlzLmRjLnJlYWR5U3RhdGUgIT09IFwib3BlblwiKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSGFuZHNoYWtlIGluY29tcGxldGUhIFNlbmRpbmcgaXMgbm90IHBvc3NpYmxlLlwiKTtcclxuICAgIH1cclxuICAgIGlmICh0eXBlb2YgcGF5bG9hZCA9PT0gXCJ1bmRlZmluZWRcIikge1xyXG4gICAgICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogbWVzc2FnZVR5cGUgfSkpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICB0aGlzLmRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IG1lc3NhZ2VUeXBlLCBwYXlsb2FkOiBwYXlsb2FkIH0pKTtcclxuICAgIH1cclxuXHJcbn07XHJcblxyXG4vKipcclxuICogVHJpZXMgdG8gY29ubmVjdCB0byB0aGUgYWRkcmVzcyB0aHJvdWdoIHRoZSBwZWVyXHJcbiAqIEBwYXJhbSBhZGRyZXNzIHtTdHJpbmd9XHJcbiAqIEByZXR1cm5zIHtQZWVyfSByZXN1bHRpbmcgcGVlclxyXG4gKi9cclxuUGVlci5wcm90b3R5cGUuYXR0ZW1wdFRvQ29ubmVjdCA9IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICB2YXIgc2VsZiA9IHRoaXM7XHJcbiAgICB2YXIgb3RoZXIgPSBIYW5kc2hha2UuY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKG9mZmVyKSB7XHJcbiAgICAgICAgc2VsZi5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLk9GRkVSLCB7b2ZmZXI6b2ZmZXIsIHRhcmdldDphZGRyZXNzLCBzb3VyY2U6QUREUkVTU30pO1xyXG4gICAgfSk7XHJcbiAgICBQZWVyQ2FjaGUucHV0UGVuZGluZyhvdGhlciwgYWRkcmVzcyk7XHJcbiAgICByZXR1cm4gb3RoZXI7XHJcbn07XHJcblxyXG5leHBvcnRzLlBlZXIgPSBQZWVyOyIsIi8qKlxyXG4gKiBDYWNoZXMgY29ubmVjdGlvbnMgdGhhdCBhcmUgb3BlbmVkIGFuZCBub3QgY2xvc2VkIHlldCBmb3IgdGhlIHB1cnBvc2Ugb2Ygc2lnbmFsaW5nXHJcbiAqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzE3LzIwMTQuXHJcbiAqL1xyXG5cclxudmFyIGNhY2hlID0ge307XHJcblxyXG52YXIgcGVuZGluZyA9IHt9O1xyXG5cclxuZXhwb3J0cy5QZWVyQ2FjaGUgPSB7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBQdXQgYSBQZWVyIHRoYXQgaXMgYWxyZWFkeSBvcGVuXHJcbiAgICAgKiBAcGFyYW0gcGVlciB7UGVlcn1cclxuICAgICAqL1xyXG4gICAgcHV0OiBmdW5jdGlvbiAocGVlcikge1xyXG4gICAgICAgIGlmICghcGVlci5pc09wZW4oKSkgdGhyb3cgbmV3IEVycm9yKFwiQ2Fubm90IHB1dCBub3Qtb3BlbmVkIHBlZXJzIGludG8gY2FjaGUhXCIpO1xyXG4gICAgICAgIGlmIChwZWVyLmFkZHJlc3MgaW4gY2FjaGUpIHRocm93IG5ldyBFcnJvcihcIkNvbm5lY3Rpb24gaXMgYWxyZWFkeSBvcGVuISBDYW5ub3QgcHV0IGludG8gY2FjaGUuXCIpOyAvL1RPRE8gcmVhbGx5Li4/XHJcblxyXG4gICAgICAgIGNhY2hlW3BlZXIuYWRkcmVzc10gPSBwZWVyO1xyXG5cclxuICAgICAgICAvLyBDbGVhciB3aGVuIGRpc2Nvbm5lY3RlZFxyXG4gICAgICAgIHBlZXIub25kaXNjb25uZWN0KGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgZGVsZXRlIGNhY2hlW3BlZXIuYWRkcmVzc107XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIGNvbnNvbGUubG9nKFwiUGVlckNhY2hlXCIsIGNhY2hlKTtcclxuICAgIH0sXHJcblxyXG4gICAgaGFzOiBmdW5jdGlvbiAoYWRkcmVzcykge1xyXG4gICAgICAgIHJldHVybiBhZGRyZXNzIGluIGNhY2hlO1xyXG4gICAgfSxcclxuXHJcbiAgICBnZXQ6IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICAgICAgcmV0dXJuIGNhY2hlW2FkZHJlc3NdO1xyXG4gICAgfSxcclxuXHJcbiAgICBwdXRQZW5kaW5nOiBmdW5jdGlvbiAocGVlciwgYWRkcmVzcykge1xyXG4gICAgICAgIGlmIChwZWVyLmlzT3BlbigpKSB0aHJvdyBuZXcgRXJyb3IoXCJDYW5ub3QgYXQgcGVlciB0byBwZW5kaW5nIGJlY2F1c2UgaXQgaXMgYWxyZWFkeSBvcGVuIVwiKTtcclxuICAgICAgICBpZiAoYWRkcmVzcyBpbiBwZW5kaW5nKSB0aHJvdyBuZXcgRXJyb3IoXCJDb25uZWN0aW9uIGlzIGFscmVhZHkgcGVuZGluZyEgQ2Fubm90IHB1dCBpbnRvIGNhY2hlLlwiKTsgLy9UT0RPIHJlYWxseS4uP1xyXG5cclxuICAgICAgICBwZWVyLm9ub3BlbihmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIGRlbGV0ZSBwZW5kaW5nW2FkZHJlc3NdO1xyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBwZW5kaW5nW2FkZHJlc3NdID0gcGVlcjtcclxuICAgIH0sXHJcblxyXG4gICAgZ2V0UGVuZGluZzogZnVuY3Rpb24gKGFkZHJlc3MpIHtcclxuICAgICAgICByZXR1cm4gcGVuZGluZ1thZGRyZXNzXTtcclxuICAgIH1cclxuXHJcbn07XHJcbiIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xMS8yMDE0LlxyXG4gKi9cclxudmFyIFV0aWxzID0gcmVxdWlyZShcInl1dGlsc1wiKTtcclxudmFyIFBlZXIgPSByZXF1aXJlKFwiLi9QZWVyLmpzXCIpLlBlZXI7XHJcbnZhciBQZWVyQ2FjaGUgPSByZXF1aXJlKFwiLi9QZWVyQ2FjaGUuanNcIikuUGVlckNhY2hlO1xyXG52YXIgTUVTU0FHRV9UWVBFID0gcmVxdWlyZShcIi4vTUVTU0FHRV9UWVBFLmpzXCIpO1xyXG4vL3ZhciBBRERSRVNTID0gVXRpbHMuZ3VpZCgpOyAvLyBwc2V1ZG8tdW5pcXVlXHJcbnZhciBBRERSRVNTID0gcmVxdWlyZShcIi4vQWRkcmVzc1wiKS5Mb2NhbEFkZHJlc3M7XHJcblxyXG52YXIgb25SZW1vdGVDb25uZWN0aW9uQ2FsbGJhY2tzID0gW107XHJcblxyXG4vKipcclxuICogQHR5cGUge09iamVjdH1cclxuICoge1xyXG4gKiAgICAgIGd1aWQxIDogcGVlcixcclxuICogICAgICBndWlkMiA6IHBlZXJcclxuICogfVxyXG4gKi9cclxuXHJcbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gQSBQIElcclxuID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xyXG5cclxuLyoqXHJcbiAqIGluaXRpYXRlcyBhIFBlZXItdG8tUGVlciBjb25uZWN0aW9uXHJcbiAqIEBwYXJhbSBjYWxsYmFja1xyXG4gKiBAcmV0dXJucyB7UGVlcn1cclxuICovXHJcbmZ1bmN0aW9uIGNyZWF0ZU9mZmVyKGNhbGxiYWNrKSB7XHJcbiAgICB2YXIgcGVlciA9IG5ldyBQZWVyKCksIHBjID0gcGVlci5wYztcclxuICAgIHBlZXIub2ZmZXJDYWxsYmFjayA9IGNhbGxiYWNrO1xyXG5cclxuICAgIHZhciBkYyA9IHBjLmNyZWF0ZURhdGFDaGFubmVsKFwicVwiLCB7cmVsaWFibGU6dHJ1ZX0pO1xyXG4gICAgcGMuY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKGRlc2MpIHtcclxuICAgICAgICBwYy5zZXRMb2NhbERlc2NyaXB0aW9uKGRlc2MsIGZ1bmN0aW9uKCkgeyB9KTtcclxuICAgIH0sIGZ1bmN0aW9uIGZhaWx1cmUoZSkgeyBjb25zb2xlLmVycm9yKGUpOyB9KTtcclxuXHJcbiAgICBkYy5vbm9wZW4gPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUywgcGF5bG9hZDogQUREUkVTU30pKTtcclxuICAgIH07XHJcblxyXG4gICAgZGMub25tZXNzYWdlID0gaGFuZGxlTWVzc2FnZShwZWVyKTtcclxuXHJcbiAgICBwZWVyLmRjID0gZGM7XHJcbiAgICByZXR1cm4gcGVlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqXHJcbiAqIEBwYXJhbSBwZWVyXHJcbiAqIEByZXR1cm5zIHtGdW5jdGlvbn1cclxuICovXHJcbmZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UocGVlcikge1xyXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIG1zZyA9IFV0aWxzLmlzU3RyaW5nKGUuZGF0YSkgPyBKU09OLnBhcnNlKGUuZGF0YSkgOiBlLmRhdGE7XHJcbiAgICAgICAgdmFyIGksIEwsIG5ld1BlZXIsIGRlc3RpbmF0aW9uUGVlcjtcclxuICAgICAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLk9GRkVSOlxyXG4gICAgICAgICAgICAgICAgaWYgKFwidGFyZ2V0XCIgaW4gbXNnLnBheWxvYWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyB3ZSBhcmUgdGhlIG1lZGlhdG9yXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKFBlZXJDYWNoZS5oYXMobXNnLnBheWxvYWQudGFyZ2V0KSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0aW5hdGlvblBlZXIgPSBQZWVyQ2FjaGUuZ2V0KG1zZy5wYXlsb2FkLnRhcmdldCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlci5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLk9GRkVSLCB7b2ZmZXI6bXNnLnBheWxvYWQub2ZmZXIsIHNvdXJjZTptc2cucGF5bG9hZC5zb3VyY2V9KTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB3ZSBjYW5ub3QgZXN0YWJsaXNoIGEgY29ubmVjdGlvbi4uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlZXIuc2VuZE1lc3NhZ2VUeXBlKE1FU1NBR0VfVFlQRS5FUlJPUl9DQU5OT1RfRklORF9QRUVSLCBtc2cucGF5bG9hZC50YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gV0UgYXJlIHRoZSBUQVJHRVQhXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3UGVlciA9IGNyZWF0ZUFuc3dlcihtc2cucGF5bG9hZC5vZmZlciwgZnVuY3Rpb24gKGFuc3dlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwZWVyLnNlbmRNZXNzYWdlVHlwZShcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1FU1NBR0VfVFlQRS5BTlNXRVIsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbnN3ZXI6IGFuc3dlcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2U6IG1zZy5wYXlsb2FkLnNvdXJjZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IEFERFJFU1NcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpID0gMCwgTCA9IG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrcy5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrc1tpXS5jYWxsKG5ld1BlZXIsbmV3UGVlcik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLkFOU1dFUjpcclxuICAgICAgICAgICAgICAgIGlmIChcInNvdXJjZVwiIGluIG1zZy5wYXlsb2FkKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gd2UgYXJlIHRoZSBtZWRpYXRvci4uXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKFBlZXJDYWNoZS5oYXMobXNnLnBheWxvYWQuc291cmNlKSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0aW5hdGlvblBlZXIgPSBQZWVyQ2FjaGUuZ2V0KG1zZy5wYXlsb2FkLnNvdXJjZSk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlci5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLkFOU1dFUiwge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5zd2VyOiBtc2cucGF5bG9hZC5hbnN3ZXIsXHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IG1zZy5wYXlsb2FkLnRhcmdldFxyXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwZWVyLnNlbmRNZXNzYWdlVHlwZShNRVNTQUdFX1RZUEUuRVJST1JfQ0FOTk9UX0ZJTkRfUEVFUiwgbXNnLnBheWxvYWQudGFyZ2V0KTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIHdlIGFyZSB0aGUgU0VOREVSIGFuZCB3ZSBhcmUgc3VwcG9zZWQgdG8gYXBwbHkgdGhlIGFuc3dlci4uXHJcbiAgICAgICAgICAgICAgICAgICAgZGVzdGluYXRpb25QZWVyID0gUGVlckNhY2hlLmdldFBlbmRpbmcobXNnLnBheWxvYWQudGFyZ2V0KTtcclxuICAgICAgICAgICAgICAgICAgICBoYW5kbGVBbnN3ZXIoZGVzdGluYXRpb25QZWVyLCBtc2cucGF5bG9hZC5hbnN3ZXIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUzpcclxuICAgICAgICAgICAgICAgIHBlZXIuYWRkcmVzcyA9IG1zZy5wYXlsb2FkO1xyXG4gICAgICAgICAgICAgICAgaSA9IDAsIEwgPSBwZWVyLm9uT3Blbi5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICBQZWVyQ2FjaGUucHV0KHBlZXIpO1xyXG4gICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcGVlci5vbk9wZW5baV0uY2FsbChwZWVyKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHBlZXIub25PcGVuID0gbnVsbDtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIE1FU1NBR0VfVFlQRS5NRVNTQUdFOlxyXG4gICAgICAgICAgICAgICAgaSA9IDAsIEwgPSBwZWVyLm9uTWVzc2FnZS5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICBwZWVyLm9uTWVzc2FnZVtpXS5jYWxsKHBlZXIsIG1zZy5wYXlsb2FkKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBY2NlcHRzIHRoZSBpbml0aWFsIFBlZXItdG8tUGVlciBpbnZpdGF0aW9uXHJcbiAqIEBwYXJhbSBvZmZlclxyXG4gKiBAcGFyYW0gY2FsbGJhY2tcclxuICogQHJldHVybnMge1BlZXJ9XHJcbiAqL1xyXG5mdW5jdGlvbiBjcmVhdGVBbnN3ZXIob2ZmZXIsIGNhbGxiYWNrKSB7XHJcbiAgICB2YXIgcGVlciA9IG5ldyBQZWVyKCksIHBjID0gcGVlci5wYztcclxuICAgIHZhciBvZmZlckRlc2MgPSBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKEpTT04ucGFyc2Uob2ZmZXIpKTtcclxuICAgIHBlZXIuY3JlYXRlQ2FsbGJhY2sgPSBjYWxsYmFjaztcclxuICAgIHBjLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyRGVzYyk7XHJcbiAgICBwYy5jcmVhdGVBbnN3ZXIoZnVuY3Rpb24gKGFuc3dlckRlc2MpIHtcclxuICAgICAgICBwYy5zZXRMb2NhbERlc2NyaXB0aW9uKGFuc3dlckRlc2MpO1xyXG4gICAgfSwgZnVuY3Rpb24gKCkgeyBjb25zb2xlLndhcm4oXCJObyBjcmVhdGUgYW5zd2VyXCIpOyB9KTtcclxuXHJcbiAgICBwYy5vbmRhdGFjaGFubmVsID0gZnVuY3Rpb24gKGUpIHtcclxuICAgICAgICB2YXIgZGMgPSBlLmNoYW5uZWwgfHwgZTsgLy8gQ2hyb21lIHNlbmRzIGV2ZW50LCBGRiBzZW5kcyByYXcgY2hhbm5lbFxyXG4gICAgICAgIHBlZXIuZGMgPSBkYztcclxuXHJcbiAgICAgICAgZGMub25vcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICBkYy5zZW5kKEpTT04uc3RyaW5naWZ5KHt0eXBlOiBNRVNTQUdFX1RZUEUuVEVMTF9BRERSRVNTLCBwYXlsb2FkOiBBRERSRVNTfSkpO1xyXG4gICAgICAgICAgICAvLyBkZWxheSBvcGVuIHVudGlsIHRoZSByZXNwb25zZSBpcyBpblxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIGRjLm9ubWVzc2FnZSA9IGhhbmRsZU1lc3NhZ2UocGVlcik7XHJcbiAgICB9O1xyXG5cclxuICAgIHJldHVybiBwZWVyO1xyXG59XHJcblxyXG4vKipcclxuICogQXBwbGllcyB0aGUgcmVzdWx0XHJcbiAqIEBwYXJhbSBwZWVyXHJcbiAqIEBwYXJhbSBhbnN3ZXJcclxuICovXHJcbmZ1bmN0aW9uIGhhbmRsZUFuc3dlcihwZWVyLCBhbnN3ZXIpIHtcclxuICAgIHZhciBhbnN3ZXJEZXNjID0gbmV3IFJUQ1Nlc3Npb25EZXNjcmlwdGlvbihKU09OLnBhcnNlKGFuc3dlcikpO1xyXG4gICAgcGVlci5wYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihhbnN3ZXJEZXNjKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFdlIHNvbWVob3cgbmVlZCB0byBub3RpZnkgQm9iLCB0aGF0IEFsaWNlIGF0dGVtcHRzIHRvIHRhbGsgdG8gaGltIVxyXG4gKiBAcGFyYW0gY2FsbGJhY2sge2Z1bmN0aW9ufSAoe1BlZXJ9KVxyXG4gKi9cclxuZnVuY3Rpb24gb25SZW1vdGVDb25uZWN0aW9uKGNhbGxiYWNrKSB7XHJcbiAgICBvblJlbW90ZUNvbm5lY3Rpb25DYWxsYmFja3MucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuIEVYUE9SVFxyXG4gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXHJcbmV4cG9ydHMuY3JlYXRlT2ZmZXIgPSBjcmVhdGVPZmZlcjtcclxuZXhwb3J0cy5oYW5kbGVBbnN3ZXIgPSBoYW5kbGVBbnN3ZXI7XHJcbmV4cG9ydHMuY3JlYXRlQW5zd2VyID0gY3JlYXRlQW5zd2VyO1xyXG5leHBvcnRzLm9uUmVtb3RlQ29ubmVjdGlvbiA9IG9uUmVtb3RlQ29ubmVjdGlvbjtcclxuZXhwb3J0cy5hZGRyZXNzID0gZnVuY3Rpb24gKCkge1xyXG4gICAgcmV0dXJuIEFERFJFU1M7XHJcbn07IiwiLypqc2xpbnQgbm9kZTp0cnVlKi9cbi8qZ2xvYmFscyBSVENQZWVyQ29ubmVjdGlvbiwgbW96UlRDUGVlckNvbm5lY3Rpb24sIHdlYmtpdFJUQ1BlZXJDb25uZWN0aW9uICovXG4vKmdsb2JhbHMgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uLCBtb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gKi9cbi8qZ2xvYmFscyBSVENJY2VDYW5kaWRhdGUsIG1velJUQ0ljZUNhbmRpZGF0ZSAqL1xuJ3VzZSBzdHJpY3QnO1xuXG52YXIgbXlSVENQZWVyQ29ubmVjdGlvbiA9IG51bGw7XG52YXIgbXlSVENTZXNzaW9uRGVzY3JpcHRpb24gPSBudWxsO1xudmFyIG15UlRDSWNlQ2FuZGlkYXRlID0gbnVsbDtcblxudmFyIHJlbmFtZUljZVVSTHMgPSBmdW5jdGlvbiAoY29uZmlnKSB7XG4gIGlmICghY29uZmlnKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghY29uZmlnLmljZVNlcnZlcnMpIHtcbiAgICByZXR1cm4gY29uZmlnO1xuICB9XG4gIGNvbmZpZy5pY2VTZXJ2ZXJzLmZvckVhY2goZnVuY3Rpb24gKHNlcnZlcikge1xuICAgIHNlcnZlci51cmwgPSBzZXJ2ZXIudXJscztcbiAgICBkZWxldGUgc2VydmVyLnVybHM7XG4gIH0pO1xuICByZXR1cm4gY29uZmlnO1xufTtcblxudmFyIGZpeENocm9tZVN0YXRzUmVzcG9uc2UgPSBmdW5jdGlvbihyZXNwb25zZSkge1xuICB2YXIgc3RhbmRhcmRSZXBvcnQgPSB7fTtcbiAgdmFyIHJlcG9ydHMgPSByZXNwb25zZS5yZXN1bHQoKTtcbiAgcmVwb3J0cy5mb3JFYWNoKGZ1bmN0aW9uKHJlcG9ydCkge1xuICAgIHZhciBzdGFuZGFyZFN0YXRzID0ge1xuICAgICAgaWQ6IHJlcG9ydC5pZCxcbiAgICAgIHRpbWVzdGFtcDogcmVwb3J0LnRpbWVzdGFtcCxcbiAgICAgIHR5cGU6IHJlcG9ydC50eXBlXG4gICAgfTtcbiAgICByZXBvcnQubmFtZXMoKS5mb3JFYWNoKGZ1bmN0aW9uKG5hbWUpIHtcbiAgICAgIHN0YW5kYXJkU3RhdHNbbmFtZV0gPSByZXBvcnQuc3RhdChuYW1lKTtcbiAgICB9KTtcbiAgICBzdGFuZGFyZFJlcG9ydFtzdGFuZGFyZFN0YXRzLmlkXSA9IHN0YW5kYXJkU3RhdHM7XG4gIH0pO1xuXG4gIHJldHVybiBzdGFuZGFyZFJlcG9ydDtcbn07XG5cbnZhciBzZXNzaW9uSGFzRGF0YSA9IGZ1bmN0aW9uKGRlc2MpIHtcbiAgaWYgKCFkZXNjKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHZhciBoYXNEYXRhID0gZmFsc2U7XG4gIHZhciBwcmVmaXggPSAnbT1hcHBsaWNhdGlvbic7XG4gIGRlc2Muc2RwLnNwbGl0KCdcXG4nKS5mb3JFYWNoKGZ1bmN0aW9uKGxpbmUpIHtcbiAgICBpZiAobGluZS5zbGljZSgwLCBwcmVmaXgubGVuZ3RoKSA9PT0gcHJlZml4KSB7XG4gICAgICBoYXNEYXRhID0gdHJ1ZTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gaGFzRGF0YTtcbn07XG5cbi8vIFVuaWZ5IFBlZXJDb25uZWN0aW9uIE9iamVjdC5cbmlmICh0eXBlb2YgUlRDUGVlckNvbm5lY3Rpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDUGVlckNvbm5lY3Rpb24gPSBSVENQZWVyQ29ubmVjdGlvbjtcbn0gZWxzZSBpZiAodHlwZW9mIG1velJUQ1BlZXJDb25uZWN0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ1BlZXJDb25uZWN0aW9uID0gZnVuY3Rpb24gKGNvbmZpZ3VyYXRpb24sIGNvbnN0cmFpbnRzKSB7XG4gICAgLy8gRmlyZWZveCB1c2VzICd1cmwnIHJhdGhlciB0aGFuICd1cmxzJyBmb3IgUlRDSWNlU2VydmVyLnVybHNcbiAgICB2YXIgcGMgPSBuZXcgbW96UlRDUGVlckNvbm5lY3Rpb24ocmVuYW1lSWNlVVJMcyhjb25maWd1cmF0aW9uKSwgY29uc3RyYWludHMpO1xuXG4gICAgLy8gRmlyZWZveCBkb2Vzbid0IGZpcmUgJ29ubmVnb3RpYXRpb25uZWVkZWQnIHdoZW4gYSBkYXRhIGNoYW5uZWwgaXMgY3JlYXRlZFxuICAgIC8vIGh0dHBzOi8vYnVnemlsbGEubW96aWxsYS5vcmcvc2hvd19idWcuY2dpP2lkPTg0MDcyOFxuICAgIHZhciBkYXRhRW5hYmxlZCA9IGZhbHNlO1xuICAgIHZhciBib3VuZENyZWF0ZURhdGFDaGFubmVsID0gcGMuY3JlYXRlRGF0YUNoYW5uZWwuYmluZChwYyk7XG4gICAgcGMuY3JlYXRlRGF0YUNoYW5uZWwgPSBmdW5jdGlvbihsYWJlbCwgZGF0YUNoYW5uZWxEaWN0KSB7XG4gICAgICB2YXIgZGMgPSBib3VuZENyZWF0ZURhdGFDaGFubmVsKGxhYmVsLCBkYXRhQ2hhbm5lbERpY3QpO1xuICAgICAgaWYgKCFkYXRhRW5hYmxlZCkge1xuICAgICAgICBkYXRhRW5hYmxlZCA9IHRydWU7XG4gICAgICAgIGlmIChwYy5vbm5lZ290aWF0aW9ubmVlZGVkICYmXG4gICAgICAgICAgICAhc2Vzc2lvbkhhc0RhdGEocGMubG9jYWxEZXNjcmlwdGlvbikgJiZcbiAgICAgICAgICAgICFzZXNzaW9uSGFzRGF0YShwYy5yZW1vdGVEZXNjcmlwdGlvbikpIHtcbiAgICAgICAgICB2YXIgZXZlbnQgPSBuZXcgRXZlbnQoJ25lZ290aWF0aW9ubmVlZGVkJyk7XG4gICAgICAgICAgcGMub25uZWdvdGlhdGlvbm5lZWRlZChldmVudCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJldHVybiBkYztcbiAgICB9O1xuXG4gICAgcmV0dXJuIHBjO1xuICB9O1xufSBlbHNlIGlmICh0eXBlb2Ygd2Via2l0UlRDUGVlckNvbm5lY3Rpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIC8vIENocm9tZSByZXR1cm5zIGEgbm9uc3RhbmRhcmQsIG5vbi1KU09OLWlmaWFibGUgcmVzcG9uc2UgZnJvbSBnZXRTdGF0cy5cbiAgbXlSVENQZWVyQ29ubmVjdGlvbiA9IGZ1bmN0aW9uKGNvbmZpZ3VyYXRpb24sIGNvbnN0cmFpbnRzKSB7XG4gICAgdmFyIHBjID0gbmV3IHdlYmtpdFJUQ1BlZXJDb25uZWN0aW9uKGNvbmZpZ3VyYXRpb24sIGNvbnN0cmFpbnRzKTtcbiAgICB2YXIgYm91bmRHZXRTdGF0cyA9IHBjLmdldFN0YXRzLmJpbmQocGMpO1xuICAgIHBjLmdldFN0YXRzID0gZnVuY3Rpb24oc2VsZWN0b3IsIHN1Y2Nlc3NDYWxsYmFjaywgZmFpbHVyZUNhbGxiYWNrKSB7XG4gICAgICB2YXIgc3VjY2Vzc0NhbGxiYWNrV3JhcHBlciA9IGZ1bmN0aW9uKGNocm9tZVN0YXRzUmVzcG9uc2UpIHtcbiAgICAgICAgc3VjY2Vzc0NhbGxiYWNrKGZpeENocm9tZVN0YXRzUmVzcG9uc2UoY2hyb21lU3RhdHNSZXNwb25zZSkpO1xuICAgICAgfTtcbiAgICAgIC8vIENocm9tZSBhbHNvIHRha2VzIGl0cyBhcmd1bWVudHMgaW4gdGhlIHdyb25nIG9yZGVyLlxuICAgICAgYm91bmRHZXRTdGF0cyhzdWNjZXNzQ2FsbGJhY2tXcmFwcGVyLCBmYWlsdXJlQ2FsbGJhY2ssIHNlbGVjdG9yKTtcbiAgICB9O1xuICAgIHJldHVybiBwYztcbiAgfTtcbn1cblxuLy8gVW5pZnkgU2Vzc2lvbkRlc2NycHRpb24gT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENTZXNzaW9uRGVzY3JpcHRpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gUlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbjtcbn1cblxuLy8gVW5pZnkgSWNlQ2FuZGlkYXRlIE9iamVjdC5cbmlmICh0eXBlb2YgUlRDSWNlQ2FuZGlkYXRlICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ0ljZUNhbmRpZGF0ZSA9IFJUQ0ljZUNhbmRpZGF0ZTtcbn0gZWxzZSBpZiAodHlwZW9mIG1velJUQ0ljZUNhbmRpZGF0ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENJY2VDYW5kaWRhdGUgPSBtb3pSVENJY2VDYW5kaWRhdGU7XG59XG5cbmV4cG9ydHMuUlRDUGVlckNvbm5lY3Rpb24gPSBteVJUQ1BlZXJDb25uZWN0aW9uO1xuZXhwb3J0cy5SVENTZXNzaW9uRGVzY3JpcHRpb24gPSBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbjtcbmV4cG9ydHMuUlRDSWNlQ2FuZGlkYXRlID0gbXlSVENJY2VDYW5kaWRhdGU7XG4iLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTAvMjAxNC5cclxuICovXHJcbihmdW5jdGlvbiAoZXhwb3J0cykge1xyXG5cclxuICAgIC8vIHBlcmZvcm1hbmNlLm5vdyBwb2x5ZmlsbFxyXG4gICAgdmFyIHBlcmYgPSBudWxsO1xyXG4gICAgaWYgKHR5cGVvZiBwZXJmb3JtYW5jZSA9PT0gJ3VuZGVmaW5lZCcpIHtcclxuICAgICAgICBwZXJmID0ge307XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIHBlcmYgPSBwZXJmb3JtYW5jZTtcclxuICAgIH1cclxuXHJcbiAgICBwZXJmLm5vdyA9IHBlcmYubm93IHx8IHBlcmYubW96Tm93IHx8IHBlcmYubXNOb3cgfHwgIHBlcmYub05vdyB8fCBwZXJmLndlYmtpdE5vdyB8fCBEYXRlLm5vdyB8fFxyXG4gICAgICAgIGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG5ldyBEYXRlKCkuZ2V0VGltZSgpO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgZnVuY3Rpb24gc3dhcChhcnJheSwgaSwgaikge1xyXG4gICAgICAgIGlmIChpICE9PSBqKSB7XHJcbiAgICAgICAgICAgIHZhciB0ZW1wID0gYXJyYXlbaV07XHJcbiAgICAgICAgICAgIGFycmF5W2ldID0gYXJyYXlbal07XHJcbiAgICAgICAgICAgIGFycmF5W2pdID0gdGVtcDtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgLypcclxuICAgIH5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+XHJcbiAgICAgKi9cclxuXHJcbiAgICB2YXIgZ2V0UmFuZG9tSW50ID0gZXhwb3J0cy5nZXRSYW5kb21JbnQgPSBmdW5jdGlvbiAobWluLCBtYXgpIHtcclxuICAgICAgICBpZiAobWluID4gbWF4KSB0aHJvdyBuZXcgRXJyb3IoXCJtaW4gbXVzdCBiZSBzbWFsbGVyIHRoYW4gbWF4ISB7XCIgKyBtaW4gKyBcIj5cIiArIG1heCArIFwifVwiICk7XHJcbiAgICAgICAgcmV0dXJuIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChtYXggLSBtaW4gKyAxKSkgKyBtaW47XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuc2FtcGxlID0gZnVuY3Rpb24gKGxpc3QsIG4pIHtcclxuICAgICAgICB2YXIgcmVzdWx0ID0gW10sIGosaSA9IDAsIEwgPSBuID4gbGlzdC5sZW5ndGggPyBsaXN0Lmxlbmd0aCA6IG4sIHMgPSBsaXN0Lmxlbmd0aCAtIDE7XHJcbiAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgIGogPSBnZXRSYW5kb21JbnQoaSxzKTtcclxuICAgICAgICAgICAgc3dhcChsaXN0LGksaik7XHJcbiAgICAgICAgICAgIHJlc3VsdC5wdXNoKGxpc3RbaV0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gcmVzdWx0O1xyXG4gICAgfTtcclxuXHJcbiAgICBleHBvcnRzLmlzU3RyaW5nID0gZnVuY3Rpb24obXlWYXIpIHtcclxuICAgICAgICByZXR1cm4gKHR5cGVvZiBteVZhciA9PT0gJ3N0cmluZycgfHwgbXlWYXIgaW5zdGFuY2VvZiBTdHJpbmcpXHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuYXNzZXJ0TGVuZ3RoID0gZnVuY3Rpb24gKGFyZywgbmJyKSB7XHJcbiAgICAgICAgaWYgKGFyZy5sZW5ndGggPT09IG5icikgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgZWxzZSB0aHJvdyBuZXcgRXJyb3IoXCJXcm9uZyBudW1iZXIgb2YgYXJndW1lbnRzOiBleHBlY3RlZDpcIiArIG5iciArIFwiLCBidXQgZ290OiBcIiArIGFyZy5sZW5ndGgpO1xyXG4gICAgfTtcclxuXHJcbiAgICBleHBvcnRzLmd1aWQgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgdmFyIGQgPSBwZXJmLm5vdygpO1xyXG4gICAgICAgIHZhciBndWlkID0gJ3h4eHh4eHh4LXh4eHgtNHh4eC15eHh4LXh4eHh4eHh4eHh4eCcucmVwbGFjZSgvW3h5XS9nLCBmdW5jdGlvbiAoYykge1xyXG4gICAgICAgICAgICB2YXIgciA9IChkICsgTWF0aC5yYW5kb20oKSAqIDE2KSAlIDE2IHwgMDtcclxuICAgICAgICAgICAgZCA9IE1hdGguZmxvb3IoZCAvIDE2KTtcclxuICAgICAgICAgICAgcmV0dXJuIChjID09PSAneCcgPyByIDogKHIgJiAweDMgfCAweDgpKS50b1N0cmluZygxNik7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgcmV0dXJuIGd1aWQ7XHJcbiAgICB9O1xyXG5cclxufSkodHlwZW9mIGV4cG9ydHMgPT09ICd1bmRlZmluZWQnID8gdGhpc1sneVV0aWxzJ10gPSB7fSA6IGV4cG9ydHMpOyJdfQ==
