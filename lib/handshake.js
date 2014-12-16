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