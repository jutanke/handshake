!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Handshake=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
exports.MESSAGE = 0|0;
exports.TELL_ADDRESS = 1|0;
exports.GET_NEIGHBORS = 2|0;
exports.REQUEST_SIGNALING = 3|0;
exports.ERROR_CANNOT_SIGNAL = 4|0;
},{}],2:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
var WebRTC = require("webrtc-adapter");
var RTCPeerConnection = WebRTC.RTCPeerConnection;
var RTCIceCandidate = WebRTC.RTCPeerConnection;
var RTCSessionDescription = WebRTC.RTCPeerConnection;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");

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

Peer.prototype.send = function (message) {
    if (this.dc === null || this.dc.readyState !== "open") {
        throw new Error("Handshake incomplete! Sending is not possible.");
    }
    this.dc.send(JSON.stringify({type: MESSAGE_TYPE.MESSAGE, payload:message }));
};
exports.Peer = Peer;
},{"./MESSAGE_TYPE.js":1,"webrtc-adapter":5}],3:[function(require,module,exports){
/**
 * Caches connections that are opened and not closed yet for the purpose of signaling
 *
 * Created by Julian on 12/17/2014.
 */

var cache = {};

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
    }

};

},{}],4:[function(require,module,exports){
/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var PeerCache = require("./PeerCache.js").PeerCache;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = Utils.guid(); // pseudo-unique

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

function handleMessage(peer) {
    return function (e) {
        var msg = Utils.isString(e.data) ? JSON.parse(e.data) : e.data;
        var i,L;
        switch (msg.type) {
            case MESSAGE_TYPE.GET_NEIGHBORS:
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

function handleAnswer(peer, answer) {
    var answerDesc = new RTCSessionDescription(JSON.parse(answer));
    peer.pc.setRemoteDescription(answerDesc);
}

/* ====================================
 EXPORT
 ==================================== */
exports.createOffer = createOffer;
exports.handleAnswer = handleAnswer;
exports.createAnswer = createAnswer;
exports.address = function () {
    return ADDRESS;
};
},{"./MESSAGE_TYPE.js":1,"./Peer.js":2,"./PeerCache.js":3,"yutils":6}],5:[function(require,module,exports){
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

},{}],6:[function(require,module,exports){
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
},{}]},{},[4])(4)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkM6XFxVc2Vyc1xcQmFrYVxcQXBwRGF0YVxcUm9hbWluZ1xcbnBtXFxub2RlX21vZHVsZXNcXGJyb3dzZXJpZnlcXG5vZGVfbW9kdWxlc1xcYnJvd3Nlci1wYWNrXFxfcHJlbHVkZS5qcyIsImxpYlxcTUVTU0FHRV9UWVBFLmpzIiwibGliXFxQZWVyLmpzIiwibGliXFxQZWVyQ2FjaGUuanMiLCJsaWJcXGhhbmRzaGFrZS5qcyIsIm5vZGVfbW9kdWxlc1xcd2VicnRjLWFkYXB0ZXJcXGFkYXB0ZXIuanMiLCJub2RlX21vZHVsZXNcXHl1dGlsc1xceXV0aWxzLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMzSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzdCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZHQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTYvMjAxNC5cclxuICovXHJcbmV4cG9ydHMuTUVTU0FHRSA9IDB8MDtcclxuZXhwb3J0cy5URUxMX0FERFJFU1MgPSAxfDA7XHJcbmV4cG9ydHMuR0VUX05FSUdIQk9SUyA9IDJ8MDtcclxuZXhwb3J0cy5SRVFVRVNUX1NJR05BTElORyA9IDN8MDtcclxuZXhwb3J0cy5FUlJPUl9DQU5OT1RfU0lHTkFMID0gNHwwOyIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xNi8yMDE0LlxyXG4gKi9cclxudmFyIFdlYlJUQyA9IHJlcXVpcmUoXCJ3ZWJydGMtYWRhcHRlclwiKTtcclxudmFyIFJUQ1BlZXJDb25uZWN0aW9uID0gV2ViUlRDLlJUQ1BlZXJDb25uZWN0aW9uO1xyXG52YXIgUlRDSWNlQ2FuZGlkYXRlID0gV2ViUlRDLlJUQ1BlZXJDb25uZWN0aW9uO1xyXG52YXIgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gV2ViUlRDLlJUQ1BlZXJDb25uZWN0aW9uO1xyXG52YXIgTUVTU0FHRV9UWVBFID0gcmVxdWlyZShcIi4vTUVTU0FHRV9UWVBFLmpzXCIpO1xyXG5cclxudmFyIElDRV9DT05GSUcgPSB7XCJpY2VTZXJ2ZXJzXCI6W1xyXG4gICAge1widXJsXCI6XCJzdHVuOjIzLjIxLjE1MC4xMjFcIn0sXHJcbiAgICB7XHJcbiAgICAgICAgJ3VybCc6ICd0dXJuOjE5Mi4xNTguMjkuMzk6MzQ3OD90cmFuc3BvcnQ9dWRwJyxcclxuICAgICAgICAnY3JlZGVudGlhbCc6ICdKWkVPRXQyVjNRYjB5MjdHUm50dDJ1MlBBWUE9JyxcclxuICAgICAgICAndXNlcm5hbWUnOiAnMjgyMjQ1MTE6MTM3OTMzMDgwOCdcclxuICAgIH1cclxuXX07XHJcblxyXG52YXIgQ09OTiA9IHsgJ29wdGlvbmFsJzogW3snRHRsc1NydHBLZXlBZ3JlZW1lbnQnOiB0cnVlfV0gfTtcclxuXHJcbi8qKlxyXG4gKlxyXG4gKiBAY29uc3RydWN0b3JcclxuICovXHJcbmZ1bmN0aW9uIFBlZXIoKSB7XHJcbiAgICB2YXIgcGMgPSBuZXcgUlRDUGVlckNvbm5lY3Rpb24oSUNFX0NPTkZJRywgQ09OTik7XHJcbiAgICB0aGlzLnBjID0gcGM7XHJcbiAgICB0aGlzLmFkZHJlc3MgPSBudWxsO1xyXG4gICAgdGhpcy5kYyA9IG51bGw7XHJcbiAgICB0aGlzLm9uT3BlbiA9IFtdO1xyXG4gICAgdGhpcy5vbk1lc3NhZ2UgPSBbXTtcclxuICAgIHRoaXMub25EaXNjb25uZWN0ID0gW107XHJcbiAgICB0aGlzLm9mZmVyQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgdGhpcy5jcmVhdGVDYWxsYmFjayA9IG51bGw7XHJcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBudWxsO1xyXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xyXG5cclxuICAgIHRoaXMuZGlzY29ubmVjdENvdW50ZXIgPSAwOyAvLyB0byBwcmV2ZW50IFwiZmFsc2VcIiBwb3NpdGl2ZS4uLlxyXG4gICAgdGhpcy50aHJlYWQgPSBzZXRJbnRlcnZhbChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgdmFyIGkgPSAwLCBMID0gc2VsZi5vbkRpc2Nvbm5lY3QubGVuZ3RoO1xyXG4gICAgICAgIGlmIChzZWxmLmRjICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIGlmKCBzZWxmLmRjLnJlYWR5U3RhdGUgPT09IFwiY2xvc2VkXCIpIHtcclxuICAgICAgICAgICAgICAgIGlmIChzZWxmLmRpc2Nvbm5lY3RDb3VudGVyID4gNSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm9uRGlzY29ubmVjdFtpXS5jYWxsKHNlbGYpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBjbGVhckludGVydmFsKHNlbGYudGhyZWFkKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5kaXNjb25uZWN0Q291bnRlciArPSAxO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2VsZi5kaXNjb25uZWN0Q291bnRlciA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9LCAxMDApO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogcmV0dXJucyB0aGUgcmVzdWx0XHJcbiAgICAgKi9cclxuICAgIGZ1bmN0aW9uIGV4ZWMoKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHNlbGYuaWNlVGltZW91dCk7XHJcbiAgICAgICAgdmFyIGQgPSBKU09OLnN0cmluZ2lmeShwYy5sb2NhbERlc2NyaXB0aW9uKTtcclxuICAgICAgICBpZiAoc2VsZi5vZmZlckNhbGxiYWNrICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIHNlbGYub2ZmZXJDYWxsYmFjay5jYWxsKHNlbGYsIGQpO1xyXG4gICAgICAgICAgICBzZWxmLm9mZmVyQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc2VsZi5jcmVhdGVDYWxsYmFjayAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBzZWxmLmNyZWF0ZUNhbGxiYWNrLmNhbGwoc2VsZiwgZCk7XHJcbiAgICAgICAgICAgIHNlbGYuY3JlYXRlQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBwYy5vbmljZWNhbmRpZGF0ZSA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgcGMub25pY2VjYW5kaWRhdGUgPSBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIGlmIChlLmNhbmRpZGF0ZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICBleGVjKCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgaWYgKHNlbGYuaWNlVGltZW91dCAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHNlbGYuaWNlVGltZW91dCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2VsZi5pY2VUaW1lb3V0ID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgICAgICBleGVjKCk7XHJcbiAgICAgICAgICAgIH0sIDEwMDApO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgcGMub25wZWVyaWRlbnRpdHkgPSBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFwicGVlciBpZGVudDpcIixlKTtcclxuICAgIH1cclxuXHJcbiAgICBwYy5vbnNpZ25hbGluZ3N0YXRlY2hhbmdlID0gZnVuY3Rpb24oZXYpIHtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgZXZlbnQgZGV0ZWN0ZWQhXCIsIGV2KTtcclxuICAgIH07XHJcbn1cclxuXHJcblBlZXIucHJvdG90eXBlLmlzT3BlbiA9IGZ1bmN0aW9uICgpIHtcclxuICAgIGlmICh0aGlzLmRjICE9PSBudWxsKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuZGMucmVhZHlTdGF0ZSA9PT0gXCJvcGVuXCI7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5kaXNjb25uZWN0ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgdGhpcy5kYy5jbG9zZSgpO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25kaXNjb25uZWN0ID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XHJcbiAgICB0aGlzLm9uRGlzY29ubmVjdC5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLm9ub3BlbiA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbk9wZW4ucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5vbm1lc3NhZ2UgPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcclxuICAgIHRoaXMub25NZXNzYWdlLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uIChtZXNzYWdlKSB7XHJcbiAgICBpZiAodGhpcy5kYyA9PT0gbnVsbCB8fCB0aGlzLmRjLnJlYWR5U3RhdGUgIT09IFwib3BlblwiKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSGFuZHNoYWtlIGluY29tcGxldGUhIFNlbmRpbmcgaXMgbm90IHBvc3NpYmxlLlwiKTtcclxuICAgIH1cclxuICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLk1FU1NBR0UsIHBheWxvYWQ6bWVzc2FnZSB9KSk7XHJcbn07XHJcbmV4cG9ydHMuUGVlciA9IFBlZXI7IiwiLyoqXHJcbiAqIENhY2hlcyBjb25uZWN0aW9ucyB0aGF0IGFyZSBvcGVuZWQgYW5kIG5vdCBjbG9zZWQgeWV0IGZvciB0aGUgcHVycG9zZSBvZiBzaWduYWxpbmdcclxuICpcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTcvMjAxNC5cclxuICovXHJcblxyXG52YXIgY2FjaGUgPSB7fTtcclxuXHJcbmV4cG9ydHMuUGVlckNhY2hlID0ge1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogUHV0IGEgUGVlciB0aGF0IGlzIGFscmVhZHkgb3BlblxyXG4gICAgICogQHBhcmFtIHBlZXIge1BlZXJ9XHJcbiAgICAgKi9cclxuICAgIHB1dDogZnVuY3Rpb24gKHBlZXIpIHtcclxuICAgICAgICBpZiAoIXBlZXIuaXNPcGVuKCkpIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBwdXQgbm90LW9wZW5lZCBwZWVycyBpbnRvIGNhY2hlIVwiKTtcclxuICAgICAgICBpZiAocGVlci5hZGRyZXNzIGluIGNhY2hlKSB0aHJvdyBuZXcgRXJyb3IoXCJDb25uZWN0aW9uIGlzIGFscmVhZHkgb3BlbiEgQ2Fubm90IHB1dCBpbnRvIGNhY2hlLlwiKTsgLy9UT0RPIHJlYWxseS4uP1xyXG5cclxuICAgICAgICBjYWNoZVtwZWVyLmFkZHJlc3NdID0gcGVlcjtcclxuXHJcbiAgICAgICAgLy8gQ2xlYXIgd2hlbiBkaXNjb25uZWN0ZWRcclxuICAgICAgICBwZWVyLm9uZGlzY29ubmVjdChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIGRlbGV0ZSBjYWNoZVtwZWVyLmFkZHJlc3NdO1xyXG4gICAgICAgIH0pO1xyXG5cclxuICAgICAgICBjb25zb2xlLmxvZyhcIlBlZXJDYWNoZVwiLCBjYWNoZSk7XHJcbiAgICB9XHJcblxyXG59O1xyXG4iLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTEvMjAxNC5cclxuICovXHJcbnZhciBVdGlscyA9IHJlcXVpcmUoXCJ5dXRpbHNcIik7XHJcbnZhciBQZWVyID0gcmVxdWlyZShcIi4vUGVlci5qc1wiKS5QZWVyO1xyXG52YXIgUGVlckNhY2hlID0gcmVxdWlyZShcIi4vUGVlckNhY2hlLmpzXCIpLlBlZXJDYWNoZTtcclxudmFyIE1FU1NBR0VfVFlQRSA9IHJlcXVpcmUoXCIuL01FU1NBR0VfVFlQRS5qc1wiKTtcclxudmFyIEFERFJFU1MgPSBVdGlscy5ndWlkKCk7IC8vIHBzZXVkby11bmlxdWVcclxuXHJcbi8qKlxyXG4gKiBAdHlwZSB7T2JqZWN0fVxyXG4gKiB7XHJcbiAqICAgICAgZ3VpZDEgOiBwZWVyLFxyXG4gKiAgICAgIGd1aWQyIDogcGVlclxyXG4gKiB9XHJcbiAqL1xyXG5cclxuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiBBIFAgSVxyXG4gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXHJcblxyXG5mdW5jdGlvbiBjcmVhdGVPZmZlcihjYWxsYmFjaykge1xyXG4gICAgdmFyIHBlZXIgPSBuZXcgUGVlcigpLCBwYyA9IHBlZXIucGM7XHJcbiAgICBwZWVyLm9mZmVyQ2FsbGJhY2sgPSBjYWxsYmFjaztcclxuXHJcbiAgICB2YXIgZGMgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbChcInFcIiwge3JlbGlhYmxlOnRydWV9KTtcclxuICAgIHBjLmNyZWF0ZU9mZmVyKGZ1bmN0aW9uIChkZXNjKSB7XHJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihkZXNjLCBmdW5jdGlvbigpIHsgfSk7XHJcbiAgICB9LCBmdW5jdGlvbiBmYWlsdXJlKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfSk7XHJcblxyXG4gICAgZGMub25vcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIGRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IE1FU1NBR0VfVFlQRS5URUxMX0FERFJFU1MsIHBheWxvYWQ6IEFERFJFU1N9KSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGRjLm9ubWVzc2FnZSA9IGhhbmRsZU1lc3NhZ2UocGVlcik7XHJcblxyXG4gICAgcGVlci5kYyA9IGRjO1xyXG4gICAgcmV0dXJuIHBlZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UocGVlcikge1xyXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIG1zZyA9IFV0aWxzLmlzU3RyaW5nKGUuZGF0YSkgPyBKU09OLnBhcnNlKGUuZGF0YSkgOiBlLmRhdGE7XHJcbiAgICAgICAgdmFyIGksTDtcclxuICAgICAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLkdFVF9ORUlHSEJPUlM6XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuVEVMTF9BRERSRVNTOlxyXG4gICAgICAgICAgICAgICAgcGVlci5hZGRyZXNzID0gbXNnLnBheWxvYWQ7XHJcbiAgICAgICAgICAgICAgICBpID0gMCwgTCA9IHBlZXIub25PcGVuLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgIFBlZXJDYWNoZS5wdXQocGVlcik7XHJcbiAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICBwZWVyLm9uT3BlbltpXS5jYWxsKHBlZXIpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcGVlci5vbk9wZW4gPSBudWxsO1xyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLk1FU1NBR0U6XHJcbiAgICAgICAgICAgICAgICBpID0gMCwgTCA9IHBlZXIub25NZXNzYWdlLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgIHBlZXIub25NZXNzYWdlW2ldLmNhbGwocGVlciwgbXNnLnBheWxvYWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxufVxyXG5cclxuZnVuY3Rpb24gY3JlYXRlQW5zd2VyKG9mZmVyLCBjYWxsYmFjaykge1xyXG4gICAgdmFyIHBlZXIgPSBuZXcgUGVlcigpLCBwYyA9IHBlZXIucGM7XHJcbiAgICB2YXIgb2ZmZXJEZXNjID0gbmV3IFJUQ1Nlc3Npb25EZXNjcmlwdGlvbihKU09OLnBhcnNlKG9mZmVyKSk7XHJcbiAgICBwZWVyLmNyZWF0ZUNhbGxiYWNrID0gY2FsbGJhY2s7XHJcbiAgICBwYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihvZmZlckRlc2MpO1xyXG4gICAgcGMuY3JlYXRlQW5zd2VyKGZ1bmN0aW9uIChhbnN3ZXJEZXNjKSB7XHJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXJEZXNjKTtcclxuICAgIH0sIGZ1bmN0aW9uICgpIHsgY29uc29sZS53YXJuKFwiTm8gY3JlYXRlIGFuc3dlclwiKTsgfSk7XHJcblxyXG4gICAgcGMub25kYXRhY2hhbm5lbCA9IGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIGRjID0gZS5jaGFubmVsIHx8IGU7IC8vIENocm9tZSBzZW5kcyBldmVudCwgRkYgc2VuZHMgcmF3IGNoYW5uZWxcclxuICAgICAgICBwZWVyLmRjID0gZGM7XHJcblxyXG4gICAgICAgIGRjLm9ub3BlbiA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUywgcGF5bG9hZDogQUREUkVTU30pKTtcclxuICAgICAgICAgICAgLy8gZGVsYXkgb3BlbiB1bnRpbCB0aGUgcmVzcG9uc2UgaXMgaW5cclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBkYy5vbm1lc3NhZ2UgPSBoYW5kbGVNZXNzYWdlKHBlZXIpO1xyXG4gICAgfTtcclxuXHJcbiAgICByZXR1cm4gcGVlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFuZGxlQW5zd2VyKHBlZXIsIGFuc3dlcikge1xyXG4gICAgdmFyIGFuc3dlckRlc2MgPSBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKEpTT04ucGFyc2UoYW5zd2VyKSk7XHJcbiAgICBwZWVyLnBjLnNldFJlbW90ZURlc2NyaXB0aW9uKGFuc3dlckRlc2MpO1xyXG59XHJcblxyXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuIEVYUE9SVFxyXG4gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXHJcbmV4cG9ydHMuY3JlYXRlT2ZmZXIgPSBjcmVhdGVPZmZlcjtcclxuZXhwb3J0cy5oYW5kbGVBbnN3ZXIgPSBoYW5kbGVBbnN3ZXI7XHJcbmV4cG9ydHMuY3JlYXRlQW5zd2VyID0gY3JlYXRlQW5zd2VyO1xyXG5leHBvcnRzLmFkZHJlc3MgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICByZXR1cm4gQUREUkVTUztcclxufTsiLCIvKmpzbGludCBub2RlOnRydWUqL1xuLypnbG9iYWxzIFJUQ1BlZXJDb25uZWN0aW9uLCBtb3pSVENQZWVyQ29ubmVjdGlvbiwgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24gKi9cbi8qZ2xvYmFscyBSVENTZXNzaW9uRGVzY3JpcHRpb24sIG1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAqL1xuLypnbG9iYWxzIFJUQ0ljZUNhbmRpZGF0ZSwgbW96UlRDSWNlQ2FuZGlkYXRlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBteVJUQ1BlZXJDb25uZWN0aW9uID0gbnVsbDtcbnZhciBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG51bGw7XG52YXIgbXlSVENJY2VDYW5kaWRhdGUgPSBudWxsO1xuXG52YXIgcmVuYW1lSWNlVVJMcyA9IGZ1bmN0aW9uIChjb25maWcpIHtcbiAgaWYgKCFjb25maWcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFjb25maWcuaWNlU2VydmVycykge1xuICAgIHJldHVybiBjb25maWc7XG4gIH1cbiAgY29uZmlnLmljZVNlcnZlcnMuZm9yRWFjaChmdW5jdGlvbiAoc2VydmVyKSB7XG4gICAgc2VydmVyLnVybCA9IHNlcnZlci51cmxzO1xuICAgIGRlbGV0ZSBzZXJ2ZXIudXJscztcbiAgfSk7XG4gIHJldHVybiBjb25maWc7XG59O1xuXG52YXIgZml4Q2hyb21lU3RhdHNSZXNwb25zZSA9IGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gIHZhciBzdGFuZGFyZFJlcG9ydCA9IHt9O1xuICB2YXIgcmVwb3J0cyA9IHJlc3BvbnNlLnJlc3VsdCgpO1xuICByZXBvcnRzLmZvckVhY2goZnVuY3Rpb24ocmVwb3J0KSB7XG4gICAgdmFyIHN0YW5kYXJkU3RhdHMgPSB7XG4gICAgICBpZDogcmVwb3J0LmlkLFxuICAgICAgdGltZXN0YW1wOiByZXBvcnQudGltZXN0YW1wLFxuICAgICAgdHlwZTogcmVwb3J0LnR5cGVcbiAgICB9O1xuICAgIHJlcG9ydC5uYW1lcygpLmZvckVhY2goZnVuY3Rpb24obmFtZSkge1xuICAgICAgc3RhbmRhcmRTdGF0c1tuYW1lXSA9IHJlcG9ydC5zdGF0KG5hbWUpO1xuICAgIH0pO1xuICAgIHN0YW5kYXJkUmVwb3J0W3N0YW5kYXJkU3RhdHMuaWRdID0gc3RhbmRhcmRTdGF0cztcbiAgfSk7XG5cbiAgcmV0dXJuIHN0YW5kYXJkUmVwb3J0O1xufTtcblxudmFyIHNlc3Npb25IYXNEYXRhID0gZnVuY3Rpb24oZGVzYykge1xuICBpZiAoIWRlc2MpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdmFyIGhhc0RhdGEgPSBmYWxzZTtcbiAgdmFyIHByZWZpeCA9ICdtPWFwcGxpY2F0aW9uJztcbiAgZGVzYy5zZHAuc3BsaXQoJ1xcbicpLmZvckVhY2goZnVuY3Rpb24obGluZSkge1xuICAgIGlmIChsaW5lLnNsaWNlKDAsIHByZWZpeC5sZW5ndGgpID09PSBwcmVmaXgpIHtcbiAgICAgIGhhc0RhdGEgPSB0cnVlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBoYXNEYXRhO1xufTtcblxuLy8gVW5pZnkgUGVlckNvbm5lY3Rpb24gT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENQZWVyQ29ubmVjdGlvbiA9IFJUQ1BlZXJDb25uZWN0aW9uO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDUGVlckNvbm5lY3Rpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDUGVlckNvbm5lY3Rpb24gPSBmdW5jdGlvbiAoY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICAvLyBGaXJlZm94IHVzZXMgJ3VybCcgcmF0aGVyIHRoYW4gJ3VybHMnIGZvciBSVENJY2VTZXJ2ZXIudXJsc1xuICAgIHZhciBwYyA9IG5ldyBtb3pSVENQZWVyQ29ubmVjdGlvbihyZW5hbWVJY2VVUkxzKGNvbmZpZ3VyYXRpb24pLCBjb25zdHJhaW50cyk7XG5cbiAgICAvLyBGaXJlZm94IGRvZXNuJ3QgZmlyZSAnb25uZWdvdGlhdGlvbm5lZWRlZCcgd2hlbiBhIGRhdGEgY2hhbm5lbCBpcyBjcmVhdGVkXG4gICAgLy8gaHR0cHM6Ly9idWd6aWxsYS5tb3ppbGxhLm9yZy9zaG93X2J1Zy5jZ2k/aWQ9ODQwNzI4XG4gICAgdmFyIGRhdGFFbmFibGVkID0gZmFsc2U7XG4gICAgdmFyIGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbC5iaW5kKHBjKTtcbiAgICBwYy5jcmVhdGVEYXRhQ2hhbm5lbCA9IGZ1bmN0aW9uKGxhYmVsLCBkYXRhQ2hhbm5lbERpY3QpIHtcbiAgICAgIHZhciBkYyA9IGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGRhdGFDaGFubmVsRGljdCk7XG4gICAgICBpZiAoIWRhdGFFbmFibGVkKSB7XG4gICAgICAgIGRhdGFFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKHBjLm9ubmVnb3RpYXRpb25uZWVkZWQgJiZcbiAgICAgICAgICAgICFzZXNzaW9uSGFzRGF0YShwYy5sb2NhbERlc2NyaXB0aW9uKSAmJlxuICAgICAgICAgICAgIXNlc3Npb25IYXNEYXRhKHBjLnJlbW90ZURlc2NyaXB0aW9uKSkge1xuICAgICAgICAgIHZhciBldmVudCA9IG5ldyBFdmVudCgnbmVnb3RpYXRpb25uZWVkZWQnKTtcbiAgICAgICAgICBwYy5vbm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGRjO1xuICAgIH07XG5cbiAgICByZXR1cm4gcGM7XG4gIH07XG59IGVsc2UgaWYgKHR5cGVvZiB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgLy8gQ2hyb21lIHJldHVybnMgYSBub25zdGFuZGFyZCwgbm9uLUpTT04taWZpYWJsZSByZXNwb25zZSBmcm9tIGdldFN0YXRzLlxuICBteVJUQ1BlZXJDb25uZWN0aW9uID0gZnVuY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICB2YXIgcGMgPSBuZXcgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpO1xuICAgIHZhciBib3VuZEdldFN0YXRzID0gcGMuZ2V0U3RhdHMuYmluZChwYyk7XG4gICAgcGMuZ2V0U3RhdHMgPSBmdW5jdGlvbihzZWxlY3Rvciwgc3VjY2Vzc0NhbGxiYWNrLCBmYWlsdXJlQ2FsbGJhY2spIHtcbiAgICAgIHZhciBzdWNjZXNzQ2FsbGJhY2tXcmFwcGVyID0gZnVuY3Rpb24oY2hyb21lU3RhdHNSZXNwb25zZSkge1xuICAgICAgICBzdWNjZXNzQ2FsbGJhY2soZml4Q2hyb21lU3RhdHNSZXNwb25zZShjaHJvbWVTdGF0c1Jlc3BvbnNlKSk7XG4gICAgICB9O1xuICAgICAgLy8gQ2hyb21lIGFsc28gdGFrZXMgaXRzIGFyZ3VtZW50cyBpbiB0aGUgd3Jvbmcgb3JkZXIuXG4gICAgICBib3VuZEdldFN0YXRzKHN1Y2Nlc3NDYWxsYmFja1dyYXBwZXIsIGZhaWx1cmVDYWxsYmFjaywgc2VsZWN0b3IpO1xuICAgIH07XG4gICAgcmV0dXJuIHBjO1xuICB9O1xufVxuXG4vLyBVbmlmeSBTZXNzaW9uRGVzY3JwdGlvbiBPYmplY3QuXG5pZiAodHlwZW9mIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENTZXNzaW9uRGVzY3JpcHRpb24gPSBSVENTZXNzaW9uRGVzY3JpcHRpb247XG59IGVsc2UgaWYgKHR5cGVvZiBtb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gbW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xufVxuXG4vLyBVbmlmeSBJY2VDYW5kaWRhdGUgT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENJY2VDYW5kaWRhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDSWNlQ2FuZGlkYXRlID0gUlRDSWNlQ2FuZGlkYXRlO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDSWNlQ2FuZGlkYXRlICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ0ljZUNhbmRpZGF0ZSA9IG1velJUQ0ljZUNhbmRpZGF0ZTtcbn1cblxuZXhwb3J0cy5SVENQZWVyQ29ubmVjdGlvbiA9IG15UlRDUGVlckNvbm5lY3Rpb247XG5leHBvcnRzLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xuZXhwb3J0cy5SVENJY2VDYW5kaWRhdGUgPSBteVJUQ0ljZUNhbmRpZGF0ZTtcbiIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xMC8yMDE0LlxyXG4gKi9cclxuKGZ1bmN0aW9uIChleHBvcnRzKSB7XHJcblxyXG4gICAgLy8gcGVyZm9ybWFuY2Uubm93IHBvbHlmaWxsXHJcbiAgICB2YXIgcGVyZiA9IG51bGw7XHJcbiAgICBpZiAodHlwZW9mIHBlcmZvcm1hbmNlID09PSAndW5kZWZpbmVkJykge1xyXG4gICAgICAgIHBlcmYgPSB7fTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcGVyZiA9IHBlcmZvcm1hbmNlO1xyXG4gICAgfVxyXG5cclxuICAgIHBlcmYubm93ID0gcGVyZi5ub3cgfHwgcGVyZi5tb3pOb3cgfHwgcGVyZi5tc05vdyB8fCAgcGVyZi5vTm93IHx8IHBlcmYud2Via2l0Tm93IHx8IERhdGUubm93IHx8XHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBzd2FwKGFycmF5LCBpLCBqKSB7XHJcbiAgICAgICAgaWYgKGkgIT09IGopIHtcclxuICAgICAgICAgICAgdmFyIHRlbXAgPSBhcnJheVtpXTtcclxuICAgICAgICAgICAgYXJyYXlbaV0gPSBhcnJheVtqXTtcclxuICAgICAgICAgICAgYXJyYXlbal0gPSB0ZW1wO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKlxyXG4gICAgfn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5cclxuICAgICAqL1xyXG5cclxuICAgIHZhciBnZXRSYW5kb21JbnQgPSBleHBvcnRzLmdldFJhbmRvbUludCA9IGZ1bmN0aW9uIChtaW4sIG1heCkge1xyXG4gICAgICAgIGlmIChtaW4gPiBtYXgpIHRocm93IG5ldyBFcnJvcihcIm1pbiBtdXN0IGJlIHNtYWxsZXIgdGhhbiBtYXghIHtcIiArIG1pbiArIFwiPlwiICsgbWF4ICsgXCJ9XCIgKTtcclxuICAgICAgICByZXR1cm4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKG1heCAtIG1pbiArIDEpKSArIG1pbjtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5zYW1wbGUgPSBmdW5jdGlvbiAobGlzdCwgbikge1xyXG4gICAgICAgIHZhciByZXN1bHQgPSBbXSwgaixpID0gMCwgTCA9IG4gPiBsaXN0Lmxlbmd0aCA/IGxpc3QubGVuZ3RoIDogbiwgcyA9IGxpc3QubGVuZ3RoIC0gMTtcclxuICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgaiA9IGdldFJhbmRvbUludChpLHMpO1xyXG4gICAgICAgICAgICBzd2FwKGxpc3QsaSxqKTtcclxuICAgICAgICAgICAgcmVzdWx0LnB1c2gobGlzdFtpXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuaXNTdHJpbmcgPSBmdW5jdGlvbihteVZhcikge1xyXG4gICAgICAgIHJldHVybiAodHlwZW9mIG15VmFyID09PSAnc3RyaW5nJyB8fCBteVZhciBpbnN0YW5jZW9mIFN0cmluZylcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5hc3NlcnRMZW5ndGggPSBmdW5jdGlvbiAoYXJnLCBuYnIpIHtcclxuICAgICAgICBpZiAoYXJnLmxlbmd0aCA9PT0gbmJyKSByZXR1cm4gdHJ1ZTtcclxuICAgICAgICBlbHNlIHRocm93IG5ldyBFcnJvcihcIldyb25nIG51bWJlciBvZiBhcmd1bWVudHM6IGV4cGVjdGVkOlwiICsgbmJyICsgXCIsIGJ1dCBnb3Q6IFwiICsgYXJnLmxlbmd0aCk7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuZ3VpZCA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICB2YXIgZCA9IHBlcmYubm93KCk7XHJcbiAgICAgICAgdmFyIGd1aWQgPSAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uIChjKSB7XHJcbiAgICAgICAgICAgIHZhciByID0gKGQgKyBNYXRoLnJhbmRvbSgpICogMTYpICUgMTYgfCAwO1xyXG4gICAgICAgICAgICBkID0gTWF0aC5mbG9vcihkIC8gMTYpO1xyXG4gICAgICAgICAgICByZXR1cm4gKGMgPT09ICd4JyA/IHIgOiAociAmIDB4MyB8IDB4OCkpLnRvU3RyaW5nKDE2KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4gZ3VpZDtcclxuICAgIH07XHJcblxyXG59KSh0eXBlb2YgZXhwb3J0cyA9PT0gJ3VuZGVmaW5lZCcgPyB0aGlzWyd5VXRpbHMnXSA9IHt9IDogZXhwb3J0cyk7Il19
