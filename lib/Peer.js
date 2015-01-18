/**
 * Created by Julian on 12/16/2014.
 */
var WebRTC = require("webrtc-adapter");
var RTCPeerConnection = WebRTC.RTCPeerConnection;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = require("./Address").LocalAddress;
var PeerCache = require("./PeerCache").PeerCache;
var Handshake = require("./handshake.js");
var Promise = require("bluebird");

var REQUEST_NEIGHBORS_TIMEOUT_MS = 5000;

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
    this.initConnector = false;
    this.verbose = false;
    this.address = null;
    this.dc = null;
    this.onOpen = [];
    this.onMessage = [];
    this.onDisconnect = [];
    this.onInitTimeout = [];
    this.offerCallback = null;
    this.createCallback = null;
    this.iceTimeout = null;
    this.onCannotFindPeer = [];
    this.requestNeighbors = null;
    this.requestNeighborsCallback = null;
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
    if (this.verbose) {
        console.log('Peer {' + this.address + '} is open...');
    }
    if (this.dc !== null) {
        return this.dc.readyState === "open";
    }
    return false;
};

Peer.prototype.disconnect = function () {
    if (this.dc === null) {
        this.pc.close();
    } else {
        this.dc.close();
    }
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

Peer.prototype.oncannotfindpeer = function (callback) {
    this.onCannotFindPeer.push(callback);
};

Peer.prototype.oninittimeout = function (callback) {
    this.onInitTimeout.push(callback);
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
    if (this.verbose) {
        console.log('send to Peer {' + this.address + '} message: ', message);
    }
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
    if (this.verbose) {
        console.log('send to Peer {' + this.address + '} message: ', {type:messageType, payload:payload});
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
    if (this.verbose) {
        console.log('ask Peer {' + this.address + '} to connect us with: ' + address);
    }
    return other;
};

/**
 *
 * @returns {Promise}
 */
Peer.prototype.getNeighbors = function () {
    if (this.requestNeighbors !== null) {
        console.warn("already requesting neighbors.. cancel old request!");
        this.requestNeighbors.cancel();
    }
    var self = this;
    this.requestNeighbors = new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () {
            self.requestNeighbors = null;
            self.requestNeighborsCallback = null;
            reject();
        },REQUEST_NEIGHBORS_TIMEOUT_MS);
        self.requestNeighborsCallback = function (neighbors) {
            clearTimeout(timeout);
            self.requestNeighbors = null;
            self.requestNeighborsCallback = null;
            resolve(neighbors);
        }
        self.sendMessageType(MESSAGE_TYPE.REQUEST_NEIGHBORS);
    }).cancellable();
    return this.requestNeighbors;
};

exports.Peer = Peer;