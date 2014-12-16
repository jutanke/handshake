!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Handshake=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
exports.MESSAGE = 0|0;
exports.TELL_ADDRESS = 1|0;
exports.GET_NEIGHBORS = 2|0;
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
        //console.log("onsignalingstatechange event detected!", ev);
    };
}

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
},{"./MESSAGE_TYPE.js":1,"webrtc-adapter":4}],3:[function(require,module,exports){
/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = Utils.guid(); // pseudounique

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
                for(;i<L;i++) {
                    peer.onOpen[i].call(peer);
                }
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
},{"./MESSAGE_TYPE.js":1,"./Peer.js":2,"yutils":5}],4:[function(require,module,exports){
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

},{}],5:[function(require,module,exports){
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
},{}]},{},[3])(3)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIkM6XFxVc2Vyc1xcQmFrYVxcQXBwRGF0YVxcUm9hbWluZ1xcbnBtXFxub2RlX21vZHVsZXNcXGJyb3dzZXJpZnlcXG5vZGVfbW9kdWxlc1xcYnJvd3Nlci1wYWNrXFxfcHJlbHVkZS5qcyIsImxpYlxcTUVTU0FHRV9UWVBFLmpzIiwibGliXFxQZWVyLmpzIiwibGliXFxoYW5kc2hha2UuanMiLCJub2RlX21vZHVsZXNcXHdlYnJ0Yy1hZGFwdGVyXFxhZGFwdGVyLmpzIiwibm9kZV9tb2R1bGVzXFx5dXRpbHNcXHl1dGlscy5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNMQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNySEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTYvMjAxNC5cclxuICovXHJcbmV4cG9ydHMuTUVTU0FHRSA9IDB8MDtcclxuZXhwb3J0cy5URUxMX0FERFJFU1MgPSAxfDA7XHJcbmV4cG9ydHMuR0VUX05FSUdIQk9SUyA9IDJ8MDsiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTYvMjAxNC5cclxuICovXHJcbnZhciBXZWJSVEMgPSByZXF1aXJlKFwid2VicnRjLWFkYXB0ZXJcIik7XHJcbnZhciBSVENQZWVyQ29ubmVjdGlvbiA9IFdlYlJUQy5SVENQZWVyQ29ubmVjdGlvbjtcclxudmFyIFJUQ0ljZUNhbmRpZGF0ZSA9IFdlYlJUQy5SVENQZWVyQ29ubmVjdGlvbjtcclxudmFyIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IFdlYlJUQy5SVENQZWVyQ29ubmVjdGlvbjtcclxudmFyIE1FU1NBR0VfVFlQRSA9IHJlcXVpcmUoXCIuL01FU1NBR0VfVFlQRS5qc1wiKTtcclxuXHJcbnZhciBJQ0VfQ09ORklHID0ge1wiaWNlU2VydmVyc1wiOltcclxuICAgIHtcInVybFwiOlwic3R1bjoyMy4yMS4xNTAuMTIxXCJ9LFxyXG4gICAge1xyXG4gICAgICAgICd1cmwnOiAndHVybjoxOTIuMTU4LjI5LjM5OjM0Nzg/dHJhbnNwb3J0PXVkcCcsXHJcbiAgICAgICAgJ2NyZWRlbnRpYWwnOiAnSlpFT0V0MlYzUWIweTI3R1JudHQydTJQQVlBPScsXHJcbiAgICAgICAgJ3VzZXJuYW1lJzogJzI4MjI0NTExOjEzNzkzMzA4MDgnXHJcbiAgICB9XHJcbl19O1xyXG5cclxudmFyIENPTk4gPSB7ICdvcHRpb25hbCc6IFt7J0R0bHNTcnRwS2V5QWdyZWVtZW50JzogdHJ1ZX1dIH07XHJcblxyXG4vKipcclxuICpcclxuICogQGNvbnN0cnVjdG9yXHJcbiAqL1xyXG5mdW5jdGlvbiBQZWVyKCkge1xyXG4gICAgdmFyIHBjID0gbmV3IFJUQ1BlZXJDb25uZWN0aW9uKElDRV9DT05GSUcsIENPTk4pO1xyXG4gICAgdGhpcy5wYyA9IHBjO1xyXG4gICAgdGhpcy5hZGRyZXNzID0gbnVsbDtcclxuICAgIHRoaXMuZGMgPSBudWxsO1xyXG4gICAgdGhpcy5vbk9wZW4gPSBbXTtcclxuICAgIHRoaXMub25NZXNzYWdlID0gW107XHJcbiAgICB0aGlzLm9uRGlzY29ubmVjdCA9IFtdO1xyXG4gICAgdGhpcy5vZmZlckNhbGxiYWNrID0gbnVsbDtcclxuICAgIHRoaXMuY3JlYXRlQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgdGhpcy5pY2VUaW1lb3V0ID0gbnVsbDtcclxuICAgIHZhciBzZWxmID0gdGhpcztcclxuXHJcbiAgICB0aGlzLmRpc2Nvbm5lY3RDb3VudGVyID0gMDsgLy8gdG8gcHJldmVudCBcImZhbHNlXCIgcG9zaXRpdmUuLi5cclxuICAgIHRoaXMudGhyZWFkID0gc2V0SW50ZXJ2YWwoZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHZhciBpID0gMCwgTCA9IHNlbGYub25EaXNjb25uZWN0Lmxlbmd0aDtcclxuICAgICAgICBpZiAoc2VsZi5kYyAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBpZiggc2VsZi5kYy5yZWFkeVN0YXRlID09PSBcImNsb3NlZFwiKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoc2VsZi5kaXNjb25uZWN0Q291bnRlciA+IDUpIHtcclxuICAgICAgICAgICAgICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgc2VsZi5vbkRpc2Nvbm5lY3RbaV0uY2FsbChzZWxmKTtcclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJJbnRlcnZhbChzZWxmLnRocmVhZCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHNlbGYuZGlzY29ubmVjdENvdW50ZXIgKz0gMTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgIHNlbGYuZGlzY29ubmVjdENvdW50ZXIgPSAwO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG5cclxuICAgIH0sIDEwMCk7XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiByZXR1cm5zIHRoZSByZXN1bHRcclxuICAgICAqL1xyXG4gICAgZnVuY3Rpb24gZXhlYygpIHtcclxuICAgICAgICBjbGVhclRpbWVvdXQoc2VsZi5pY2VUaW1lb3V0KTtcclxuICAgICAgICB2YXIgZCA9IEpTT04uc3RyaW5naWZ5KHBjLmxvY2FsRGVzY3JpcHRpb24pO1xyXG4gICAgICAgIGlmIChzZWxmLm9mZmVyQ2FsbGJhY2sgIT09IG51bGwpIHtcclxuICAgICAgICAgICAgc2VsZi5vZmZlckNhbGxiYWNrLmNhbGwoc2VsZiwgZCk7XHJcbiAgICAgICAgICAgIHNlbGYub2ZmZXJDYWxsYmFjayA9IG51bGw7XHJcbiAgICAgICAgfSBlbHNlIGlmIChzZWxmLmNyZWF0ZUNhbGxiYWNrICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIHNlbGYuY3JlYXRlQ2FsbGJhY2suY2FsbChzZWxmLCBkKTtcclxuICAgICAgICAgICAgc2VsZi5jcmVhdGVDYWxsYmFjayA9IG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHBjLm9uaWNlY2FuZGlkYXRlID0gbnVsbDtcclxuICAgIH1cclxuXHJcbiAgICBwYy5vbmljZWNhbmRpZGF0ZSA9IGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgaWYgKGUuY2FuZGlkYXRlID09PSBudWxsKSB7XHJcbiAgICAgICAgICAgIGV4ZWMoKTtcclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBpZiAoc2VsZi5pY2VUaW1lb3V0ICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoc2VsZi5pY2VUaW1lb3V0KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZWxmLmljZVRpbWVvdXQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgICAgIGV4ZWMoKTtcclxuICAgICAgICAgICAgfSwgMTAwMCk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBwYy5vbnBlZXJpZGVudGl0eSA9IGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJwZWVyIGlkZW50OlwiLGUpO1xyXG4gICAgfVxyXG5cclxuICAgIHBjLm9uc2lnbmFsaW5nc3RhdGVjaGFuZ2UgPSBmdW5jdGlvbihldikge1xyXG4gICAgICAgIC8vY29uc29sZS5sb2coXCJvbnNpZ25hbGluZ3N0YXRlY2hhbmdlIGV2ZW50IGRldGVjdGVkIVwiLCBldik7XHJcbiAgICB9O1xyXG59XHJcblxyXG5QZWVyLnByb3RvdHlwZS5kaXNjb25uZWN0ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgdGhpcy5kYy5jbG9zZSgpO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25kaXNjb25uZWN0ID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XHJcbiAgICB0aGlzLm9uRGlzY29ubmVjdC5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLm9ub3BlbiA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbk9wZW4ucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5vbm1lc3NhZ2UgPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcclxuICAgIHRoaXMub25NZXNzYWdlLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uIChtZXNzYWdlKSB7XHJcbiAgICBpZiAodGhpcy5kYyA9PT0gbnVsbCB8fCB0aGlzLmRjLnJlYWR5U3RhdGUgIT09IFwib3BlblwiKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSGFuZHNoYWtlIGluY29tcGxldGUhIFNlbmRpbmcgaXMgbm90IHBvc3NpYmxlLlwiKTtcclxuICAgIH1cclxuICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLk1FU1NBR0UsIHBheWxvYWQ6bWVzc2FnZSB9KSk7XHJcbn07XHJcbmV4cG9ydHMuUGVlciA9IFBlZXI7IiwiLyoqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzExLzIwMTQuXHJcbiAqL1xyXG52YXIgVXRpbHMgPSByZXF1aXJlKFwieXV0aWxzXCIpO1xyXG52YXIgUGVlciA9IHJlcXVpcmUoXCIuL1BlZXIuanNcIikuUGVlcjtcclxudmFyIE1FU1NBR0VfVFlQRSA9IHJlcXVpcmUoXCIuL01FU1NBR0VfVFlQRS5qc1wiKTtcclxudmFyIEFERFJFU1MgPSBVdGlscy5ndWlkKCk7IC8vIHBzZXVkb3VuaXF1ZVxyXG5cclxuLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiBBIFAgSVxyXG4gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXHJcblxyXG5mdW5jdGlvbiBjcmVhdGVPZmZlcihjYWxsYmFjaykge1xyXG4gICAgdmFyIHBlZXIgPSBuZXcgUGVlcigpLCBwYyA9IHBlZXIucGM7XHJcbiAgICBwZWVyLm9mZmVyQ2FsbGJhY2sgPSBjYWxsYmFjaztcclxuXHJcbiAgICB2YXIgZGMgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbChcInFcIiwge3JlbGlhYmxlOnRydWV9KTtcclxuICAgIHBjLmNyZWF0ZU9mZmVyKGZ1bmN0aW9uIChkZXNjKSB7XHJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihkZXNjLCBmdW5jdGlvbigpIHsgfSk7XHJcbiAgICB9LCBmdW5jdGlvbiBmYWlsdXJlKGUpIHsgY29uc29sZS5lcnJvcihlKTsgfSk7XHJcblxyXG4gICAgZGMub25vcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIGRjLnNlbmQoSlNPTi5zdHJpbmdpZnkoe3R5cGU6IE1FU1NBR0VfVFlQRS5URUxMX0FERFJFU1MsIHBheWxvYWQ6IEFERFJFU1N9KSk7XHJcbiAgICB9O1xyXG5cclxuICAgIGRjLm9ubWVzc2FnZSA9IGhhbmRsZU1lc3NhZ2UocGVlcik7XHJcblxyXG4gICAgcGVlci5kYyA9IGRjO1xyXG4gICAgcmV0dXJuIHBlZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UocGVlcikge1xyXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIG1zZyA9IFV0aWxzLmlzU3RyaW5nKGUuZGF0YSkgPyBKU09OLnBhcnNlKGUuZGF0YSkgOiBlLmRhdGE7XHJcbiAgICAgICAgdmFyIGksTDtcclxuICAgICAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLkdFVF9ORUlHSEJPUlM6XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuVEVMTF9BRERSRVNTOlxyXG4gICAgICAgICAgICAgICAgcGVlci5hZGRyZXNzID0gbXNnLnBheWxvYWQ7XHJcbiAgICAgICAgICAgICAgICBpID0gMCwgTCA9IHBlZXIub25PcGVuLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgIHBlZXIub25PcGVuW2ldLmNhbGwocGVlcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuTUVTU0FHRTpcclxuICAgICAgICAgICAgICAgIGkgPSAwLCBMID0gcGVlci5vbk1lc3NhZ2UubGVuZ3RoO1xyXG4gICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcGVlci5vbk1lc3NhZ2VbaV0uY2FsbChwZWVyLCBtc2cucGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG59XHJcblxyXG5mdW5jdGlvbiBjcmVhdGVBbnN3ZXIob2ZmZXIsIGNhbGxiYWNrKSB7XHJcbiAgICB2YXIgcGVlciA9IG5ldyBQZWVyKCksIHBjID0gcGVlci5wYztcclxuICAgIHZhciBvZmZlckRlc2MgPSBuZXcgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uKEpTT04ucGFyc2Uob2ZmZXIpKTtcclxuICAgIHBlZXIuY3JlYXRlQ2FsbGJhY2sgPSBjYWxsYmFjaztcclxuICAgIHBjLnNldFJlbW90ZURlc2NyaXB0aW9uKG9mZmVyRGVzYyk7XHJcbiAgICBwYy5jcmVhdGVBbnN3ZXIoZnVuY3Rpb24gKGFuc3dlckRlc2MpIHtcclxuICAgICAgICBwYy5zZXRMb2NhbERlc2NyaXB0aW9uKGFuc3dlckRlc2MpO1xyXG4gICAgfSwgZnVuY3Rpb24gKCkgeyBjb25zb2xlLndhcm4oXCJObyBjcmVhdGUgYW5zd2VyXCIpOyB9KTtcclxuXHJcbiAgICBwYy5vbmRhdGFjaGFubmVsID0gZnVuY3Rpb24gKGUpIHtcclxuICAgICAgICB2YXIgZGMgPSBlLmNoYW5uZWwgfHwgZTsgLy8gQ2hyb21lIHNlbmRzIGV2ZW50LCBGRiBzZW5kcyByYXcgY2hhbm5lbFxyXG4gICAgICAgIHBlZXIuZGMgPSBkYztcclxuXHJcbiAgICAgICAgZGMub25vcGVuID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICBkYy5zZW5kKEpTT04uc3RyaW5naWZ5KHt0eXBlOiBNRVNTQUdFX1RZUEUuVEVMTF9BRERSRVNTLCBwYXlsb2FkOiBBRERSRVNTfSkpO1xyXG4gICAgICAgICAgICAvLyBkZWxheSBvcGVuIHVudGlsIHRoZSByZXNwb25zZSBpcyBpblxyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIGRjLm9ubWVzc2FnZSA9IGhhbmRsZU1lc3NhZ2UocGVlcik7XHJcbiAgICB9O1xyXG5cclxuICAgIHJldHVybiBwZWVyO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoYW5kbGVBbnN3ZXIocGVlciwgYW5zd2VyKSB7XHJcbiAgICB2YXIgYW5zd2VyRGVzYyA9IG5ldyBSVENTZXNzaW9uRGVzY3JpcHRpb24oSlNPTi5wYXJzZShhbnN3ZXIpKTtcclxuICAgIHBlZXIucGMuc2V0UmVtb3RlRGVzY3JpcHRpb24oYW5zd2VyRGVzYyk7XHJcbn1cclxuXHJcbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gRVhQT1JUXHJcbiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi9cclxuZXhwb3J0cy5jcmVhdGVPZmZlciA9IGNyZWF0ZU9mZmVyO1xyXG5leHBvcnRzLmhhbmRsZUFuc3dlciA9IGhhbmRsZUFuc3dlcjtcclxuZXhwb3J0cy5jcmVhdGVBbnN3ZXIgPSBjcmVhdGVBbnN3ZXI7XHJcbmV4cG9ydHMuYWRkcmVzcyA9IGZ1bmN0aW9uICgpIHtcclxuICAgIHJldHVybiBBRERSRVNTO1xyXG59OyIsIi8qanNsaW50IG5vZGU6dHJ1ZSovXG4vKmdsb2JhbHMgUlRDUGVlckNvbm5lY3Rpb24sIG1velJUQ1BlZXJDb25uZWN0aW9uLCB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbiAqL1xuLypnbG9iYWxzIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiwgbW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uICovXG4vKmdsb2JhbHMgUlRDSWNlQ2FuZGlkYXRlLCBtb3pSVENJY2VDYW5kaWRhdGUgKi9cbid1c2Ugc3RyaWN0JztcblxudmFyIG15UlRDUGVlckNvbm5lY3Rpb24gPSBudWxsO1xudmFyIG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gbnVsbDtcbnZhciBteVJUQ0ljZUNhbmRpZGF0ZSA9IG51bGw7XG5cbnZhciByZW5hbWVJY2VVUkxzID0gZnVuY3Rpb24gKGNvbmZpZykge1xuICBpZiAoIWNvbmZpZykge1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoIWNvbmZpZy5pY2VTZXJ2ZXJzKSB7XG4gICAgcmV0dXJuIGNvbmZpZztcbiAgfVxuICBjb25maWcuaWNlU2VydmVycy5mb3JFYWNoKGZ1bmN0aW9uIChzZXJ2ZXIpIHtcbiAgICBzZXJ2ZXIudXJsID0gc2VydmVyLnVybHM7XG4gICAgZGVsZXRlIHNlcnZlci51cmxzO1xuICB9KTtcbiAgcmV0dXJuIGNvbmZpZztcbn07XG5cbnZhciBmaXhDaHJvbWVTdGF0c1Jlc3BvbnNlID0gZnVuY3Rpb24ocmVzcG9uc2UpIHtcbiAgdmFyIHN0YW5kYXJkUmVwb3J0ID0ge307XG4gIHZhciByZXBvcnRzID0gcmVzcG9uc2UucmVzdWx0KCk7XG4gIHJlcG9ydHMuZm9yRWFjaChmdW5jdGlvbihyZXBvcnQpIHtcbiAgICB2YXIgc3RhbmRhcmRTdGF0cyA9IHtcbiAgICAgIGlkOiByZXBvcnQuaWQsXG4gICAgICB0aW1lc3RhbXA6IHJlcG9ydC50aW1lc3RhbXAsXG4gICAgICB0eXBlOiByZXBvcnQudHlwZVxuICAgIH07XG4gICAgcmVwb3J0Lm5hbWVzKCkuZm9yRWFjaChmdW5jdGlvbihuYW1lKSB7XG4gICAgICBzdGFuZGFyZFN0YXRzW25hbWVdID0gcmVwb3J0LnN0YXQobmFtZSk7XG4gICAgfSk7XG4gICAgc3RhbmRhcmRSZXBvcnRbc3RhbmRhcmRTdGF0cy5pZF0gPSBzdGFuZGFyZFN0YXRzO1xuICB9KTtcblxuICByZXR1cm4gc3RhbmRhcmRSZXBvcnQ7XG59O1xuXG52YXIgc2Vzc2lvbkhhc0RhdGEgPSBmdW5jdGlvbihkZXNjKSB7XG4gIGlmICghZGVzYykge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICB2YXIgaGFzRGF0YSA9IGZhbHNlO1xuICB2YXIgcHJlZml4ID0gJ209YXBwbGljYXRpb24nO1xuICBkZXNjLnNkcC5zcGxpdCgnXFxuJykuZm9yRWFjaChmdW5jdGlvbihsaW5lKSB7XG4gICAgaWYgKGxpbmUuc2xpY2UoMCwgcHJlZml4Lmxlbmd0aCkgPT09IHByZWZpeCkge1xuICAgICAgaGFzRGF0YSA9IHRydWU7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGhhc0RhdGE7XG59O1xuXG4vLyBVbmlmeSBQZWVyQ29ubmVjdGlvbiBPYmplY3QuXG5pZiAodHlwZW9mIFJUQ1BlZXJDb25uZWN0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ1BlZXJDb25uZWN0aW9uID0gUlRDUGVlckNvbm5lY3Rpb247XG59IGVsc2UgaWYgKHR5cGVvZiBtb3pSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENQZWVyQ29ubmVjdGlvbiA9IGZ1bmN0aW9uIChjb25maWd1cmF0aW9uLCBjb25zdHJhaW50cykge1xuICAgIC8vIEZpcmVmb3ggdXNlcyAndXJsJyByYXRoZXIgdGhhbiAndXJscycgZm9yIFJUQ0ljZVNlcnZlci51cmxzXG4gICAgdmFyIHBjID0gbmV3IG1velJUQ1BlZXJDb25uZWN0aW9uKHJlbmFtZUljZVVSTHMoY29uZmlndXJhdGlvbiksIGNvbnN0cmFpbnRzKTtcblxuICAgIC8vIEZpcmVmb3ggZG9lc24ndCBmaXJlICdvbm5lZ290aWF0aW9ubmVlZGVkJyB3aGVuIGEgZGF0YSBjaGFubmVsIGlzIGNyZWF0ZWRcbiAgICAvLyBodHRwczovL2J1Z3ppbGxhLm1vemlsbGEub3JnL3Nob3dfYnVnLmNnaT9pZD04NDA3MjhcbiAgICB2YXIgZGF0YUVuYWJsZWQgPSBmYWxzZTtcbiAgICB2YXIgYm91bmRDcmVhdGVEYXRhQ2hhbm5lbCA9IHBjLmNyZWF0ZURhdGFDaGFubmVsLmJpbmQocGMpO1xuICAgIHBjLmNyZWF0ZURhdGFDaGFubmVsID0gZnVuY3Rpb24obGFiZWwsIGRhdGFDaGFubmVsRGljdCkge1xuICAgICAgdmFyIGRjID0gYm91bmRDcmVhdGVEYXRhQ2hhbm5lbChsYWJlbCwgZGF0YUNoYW5uZWxEaWN0KTtcbiAgICAgIGlmICghZGF0YUVuYWJsZWQpIHtcbiAgICAgICAgZGF0YUVuYWJsZWQgPSB0cnVlO1xuICAgICAgICBpZiAocGMub25uZWdvdGlhdGlvbm5lZWRlZCAmJlxuICAgICAgICAgICAgIXNlc3Npb25IYXNEYXRhKHBjLmxvY2FsRGVzY3JpcHRpb24pICYmXG4gICAgICAgICAgICAhc2Vzc2lvbkhhc0RhdGEocGMucmVtb3RlRGVzY3JpcHRpb24pKSB7XG4gICAgICAgICAgdmFyIGV2ZW50ID0gbmV3IEV2ZW50KCduZWdvdGlhdGlvbm5lZWRlZCcpO1xuICAgICAgICAgIHBjLm9ubmVnb3RpYXRpb25uZWVkZWQoZXZlbnQpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICByZXR1cm4gZGM7XG4gICAgfTtcblxuICAgIHJldHVybiBwYztcbiAgfTtcbn0gZWxzZSBpZiAodHlwZW9mIHdlYmtpdFJUQ1BlZXJDb25uZWN0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICAvLyBDaHJvbWUgcmV0dXJucyBhIG5vbnN0YW5kYXJkLCBub24tSlNPTi1pZmlhYmxlIHJlc3BvbnNlIGZyb20gZ2V0U3RhdHMuXG4gIG15UlRDUGVlckNvbm5lY3Rpb24gPSBmdW5jdGlvbihjb25maWd1cmF0aW9uLCBjb25zdHJhaW50cykge1xuICAgIHZhciBwYyA9IG5ldyB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbihjb25maWd1cmF0aW9uLCBjb25zdHJhaW50cyk7XG4gICAgdmFyIGJvdW5kR2V0U3RhdHMgPSBwYy5nZXRTdGF0cy5iaW5kKHBjKTtcbiAgICBwYy5nZXRTdGF0cyA9IGZ1bmN0aW9uKHNlbGVjdG9yLCBzdWNjZXNzQ2FsbGJhY2ssIGZhaWx1cmVDYWxsYmFjaykge1xuICAgICAgdmFyIHN1Y2Nlc3NDYWxsYmFja1dyYXBwZXIgPSBmdW5jdGlvbihjaHJvbWVTdGF0c1Jlc3BvbnNlKSB7XG4gICAgICAgIHN1Y2Nlc3NDYWxsYmFjayhmaXhDaHJvbWVTdGF0c1Jlc3BvbnNlKGNocm9tZVN0YXRzUmVzcG9uc2UpKTtcbiAgICAgIH07XG4gICAgICAvLyBDaHJvbWUgYWxzbyB0YWtlcyBpdHMgYXJndW1lbnRzIGluIHRoZSB3cm9uZyBvcmRlci5cbiAgICAgIGJvdW5kR2V0U3RhdHMoc3VjY2Vzc0NhbGxiYWNrV3JhcHBlciwgZmFpbHVyZUNhbGxiYWNrLCBzZWxlY3Rvcik7XG4gICAgfTtcbiAgICByZXR1cm4gcGM7XG4gIH07XG59XG5cbi8vIFVuaWZ5IFNlc3Npb25EZXNjcnB0aW9uIE9iamVjdC5cbmlmICh0eXBlb2YgUlRDU2Vzc2lvbkRlc2NyaXB0aW9uICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IFJUQ1Nlc3Npb25EZXNjcmlwdGlvbjtcbn0gZWxzZSBpZiAodHlwZW9mIG1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENTZXNzaW9uRGVzY3JpcHRpb24gPSBtb3pSVENTZXNzaW9uRGVzY3JpcHRpb247XG59XG5cbi8vIFVuaWZ5IEljZUNhbmRpZGF0ZSBPYmplY3QuXG5pZiAodHlwZW9mIFJUQ0ljZUNhbmRpZGF0ZSAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENJY2VDYW5kaWRhdGUgPSBSVENJY2VDYW5kaWRhdGU7XG59IGVsc2UgaWYgKHR5cGVvZiBtb3pSVENJY2VDYW5kaWRhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDSWNlQ2FuZGlkYXRlID0gbW96UlRDSWNlQ2FuZGlkYXRlO1xufVxuXG5leHBvcnRzLlJUQ1BlZXJDb25uZWN0aW9uID0gbXlSVENQZWVyQ29ubmVjdGlvbjtcbmV4cG9ydHMuUlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gbXlSVENTZXNzaW9uRGVzY3JpcHRpb247XG5leHBvcnRzLlJUQ0ljZUNhbmRpZGF0ZSA9IG15UlRDSWNlQ2FuZGlkYXRlO1xuIiwiLyoqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzEwLzIwMTQuXHJcbiAqL1xyXG4oZnVuY3Rpb24gKGV4cG9ydHMpIHtcclxuXHJcbiAgICAvLyBwZXJmb3JtYW5jZS5ub3cgcG9seWZpbGxcclxuICAgIHZhciBwZXJmID0gbnVsbDtcclxuICAgIGlmICh0eXBlb2YgcGVyZm9ybWFuY2UgPT09ICd1bmRlZmluZWQnKSB7XHJcbiAgICAgICAgcGVyZiA9IHt9O1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgICBwZXJmID0gcGVyZm9ybWFuY2U7XHJcbiAgICB9XHJcblxyXG4gICAgcGVyZi5ub3cgPSBwZXJmLm5vdyB8fCBwZXJmLm1vek5vdyB8fCBwZXJmLm1zTm93IHx8ICBwZXJmLm9Ob3cgfHwgcGVyZi53ZWJraXROb3cgfHwgRGF0ZS5ub3cgfHxcclxuICAgICAgICBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBuZXcgRGF0ZSgpLmdldFRpbWUoKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgIGZ1bmN0aW9uIHN3YXAoYXJyYXksIGksIGopIHtcclxuICAgICAgICBpZiAoaSAhPT0gaikge1xyXG4gICAgICAgICAgICB2YXIgdGVtcCA9IGFycmF5W2ldO1xyXG4gICAgICAgICAgICBhcnJheVtpXSA9IGFycmF5W2pdO1xyXG4gICAgICAgICAgICBhcnJheVtqXSA9IHRlbXA7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIC8qXHJcbiAgICB+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+flxyXG4gICAgICovXHJcblxyXG4gICAgdmFyIGdldFJhbmRvbUludCA9IGV4cG9ydHMuZ2V0UmFuZG9tSW50ID0gZnVuY3Rpb24gKG1pbiwgbWF4KSB7XHJcbiAgICAgICAgaWYgKG1pbiA+IG1heCkgdGhyb3cgbmV3IEVycm9yKFwibWluIG11c3QgYmUgc21hbGxlciB0aGFuIG1heCEge1wiICsgbWluICsgXCI+XCIgKyBtYXggKyBcIn1cIiApO1xyXG4gICAgICAgIHJldHVybiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAobWF4IC0gbWluICsgMSkpICsgbWluO1xyXG4gICAgfTtcclxuXHJcbiAgICBleHBvcnRzLnNhbXBsZSA9IGZ1bmN0aW9uIChsaXN0LCBuKSB7XHJcbiAgICAgICAgdmFyIHJlc3VsdCA9IFtdLCBqLGkgPSAwLCBMID0gbiA+IGxpc3QubGVuZ3RoID8gbGlzdC5sZW5ndGggOiBuLCBzID0gbGlzdC5sZW5ndGggLSAxO1xyXG4gICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICBqID0gZ2V0UmFuZG9tSW50KGkscyk7XHJcbiAgICAgICAgICAgIHN3YXAobGlzdCxpLGopO1xyXG4gICAgICAgICAgICByZXN1bHQucHVzaChsaXN0W2ldKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5pc1N0cmluZyA9IGZ1bmN0aW9uKG15VmFyKSB7XHJcbiAgICAgICAgcmV0dXJuICh0eXBlb2YgbXlWYXIgPT09ICdzdHJpbmcnIHx8IG15VmFyIGluc3RhbmNlb2YgU3RyaW5nKVxyXG4gICAgfTtcclxuXHJcbiAgICBleHBvcnRzLmFzc2VydExlbmd0aCA9IGZ1bmN0aW9uIChhcmcsIG5icikge1xyXG4gICAgICAgIGlmIChhcmcubGVuZ3RoID09PSBuYnIpIHJldHVybiB0cnVlO1xyXG4gICAgICAgIGVsc2UgdGhyb3cgbmV3IEVycm9yKFwiV3JvbmcgbnVtYmVyIG9mIGFyZ3VtZW50czogZXhwZWN0ZWQ6XCIgKyBuYnIgKyBcIiwgYnV0IGdvdDogXCIgKyBhcmcubGVuZ3RoKTtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5ndWlkID0gZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHZhciBkID0gcGVyZi5ub3coKTtcclxuICAgICAgICB2YXIgZ3VpZCA9ICd4eHh4eHh4eC14eHh4LTR4eHgteXh4eC14eHh4eHh4eHh4eHgnLnJlcGxhY2UoL1t4eV0vZywgZnVuY3Rpb24gKGMpIHtcclxuICAgICAgICAgICAgdmFyIHIgPSAoZCArIE1hdGgucmFuZG9tKCkgKiAxNikgJSAxNiB8IDA7XHJcbiAgICAgICAgICAgIGQgPSBNYXRoLmZsb29yKGQgLyAxNik7XHJcbiAgICAgICAgICAgIHJldHVybiAoYyA9PT0gJ3gnID8gciA6IChyICYgMHgzIHwgMHg4KSkudG9TdHJpbmcoMTYpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIHJldHVybiBndWlkO1xyXG4gICAgfTtcclxuXHJcbn0pKHR5cGVvZiBleHBvcnRzID09PSAndW5kZWZpbmVkJyA/IHRoaXNbJ3lVdGlscyddID0ge30gOiBleHBvcnRzKTsiXX0=
