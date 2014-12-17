# Handshake.js

Simple library to initiate a WebRTC handshake between peers.
To exchange the Handshake, some sort of signaling is needed.

## Alice
```javascript
// A create an offer..
var peer = Handshake.createOffer(function(offer){
    // we need to send {offer} to Bob
    ...
});


...
// C apply the others answer..
Handshake.handleAnswer(peer, ANSWER_FROM_BOB);

// API

peer.onopen(function(){
    // we can send data now!
    peer.send("Hello World");
});

peer.onmessage(function(msg){
    console.log(msg);
});

```

## Bob
```javascript
// B answer to the offer..
var peer = Handshake.createAnswer(function(answer){
    // we need to send {answer} back to Alice
    ...
});

// API

peer.onopen(function(){
    // we can send data now!
    peer.send("Hello World back");
});

peer.onmessage(function(msg){
    console.log(msg);
});

```