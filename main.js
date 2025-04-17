'use strict';

const CryptoJS   = require("crypto-js");
const express    = require("express");
const bodyParser = require("body-parser");
const WebSocket  = require("ws");

// Порты и список пиров (P2P)
const http_port    = process.env.HTTP_PORT || 3001;
const p2p_port     = process.env.P2P_PORT  || 6001;
const initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];

// Класс блока
class Block {
  constructor(index, previousHash, timestamp, data, hash, difficulty, nonce) {
    this.index        = index;
    this.previousHash = previousHash.toString();
    this.timestamp    = timestamp;
    this.data         = data;
    this.hash         = hash.toString();
    this.difficulty   = difficulty;
    this.nonce        = nonce;
  }
}

// Генезис‑блок
const getGenesisBlock = () => 
  new Block(
    0,
    "0",
    1682839690,
    "RUT-MIIT first block",
    "8d9d5a7ff4a78042ea6737bf59c772f8ed27ef3c9b576eac1976c91aaf48d2de",
    0,
    0
  );

let blockchain = [ getGenesisBlock() ];

// Проверка простоты (для кастомного PoW)
function isPrime(num) {
  if (num < 2) return false;
  if (num % 2 === 0 && num !== 2) return false;
  const limit = Math.floor(Math.sqrt(num));
  for (let i = 3; i <= limit; i += 2) {
    if (num % i === 0) return false;
  }
  return true;
}

// Расчёт SHA256‑хеша
function calculateHash(index, previousHash, timestamp, data, nonce) {
  return CryptoJS.SHA256(index + previousHash + timestamp + data + nonce).toString();
}

// Создание нового блока по «майнингу»
function mineBlock(blockData) {
  const previousBlock = blockchain[blockchain.length - 1];
  const nextIndex     = previousBlock.index + 1;
  let nonce           = 0;
  let timestamp       = Math.floor(Date.now() / 1000);
  let hash;

  // Пока не найдём простое число в последних 4 hex‑символах
  while (true) {
    timestamp = Math.floor(Date.now() / 1000);
    hash = calculateHash(nextIndex, previousBlock.hash, timestamp, blockData, nonce);

    const tailHex = hash.slice(-4);
    const tailNum = parseInt(tailHex, 16);

    if (isPrime(tailNum)) {
      console.log(`🔥 Block mined! index=${nextIndex} nonce=${nonce} tail=0x${tailHex} (${tailNum}) is prime`);
      break;
    }

    nonce++;
  }

  return new Block(nextIndex, previousBlock.hash, timestamp, blockData, hash, /*difficulty*/ null, nonce);
}

// Добавление блока в цепочку (с проверкой)
function calculateHashForBlock(block) {
  return calculateHash(block.index, block.previousHash, block.timestamp, block.data, block.nonce);
}

function isValidNewBlock(newBlock, previousBlock) {
  if (previousBlock.index + 1 !== newBlock.index) {
    console.log('Invalid index');
    return false;
  } else if (previousBlock.hash !== newBlock.previousHash) {
    console.log('Invalid previousHash');
    return false;
  } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
    console.log('Invalid hash: ' + calculateHashForBlock(newBlock) + ' vs ' + newBlock.hash);
    return false;
  }
  return true;
}

function addBlock(newBlock) {
  if (isValidNewBlock(newBlock, blockchain[blockchain.length - 1])) {
    blockchain.push(newBlock);
  }
}

// Замена цепочки, если новая длиннее и валидна
function isValidChain(chain) {
  if (JSON.stringify(chain[0]) !== JSON.stringify(getGenesisBlock())) {
    return false;
  }
  for (let i = 1; i < chain.length; i++) {
    if (!isValidNewBlock(chain[i], chain[i - 1])) {
      return false;
    }
  }
  return true;
}

function replaceChain(newBlocks) {
  if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
    console.log('Received blockchain is valid. Replacing current blockchain');
    blockchain = newBlocks;
    broadcast(responseLatestMsg());
  } else {
    console.log('Received blockchain invalid or shorter. Do nothing');
  }
}

// P2P‑обмен
const sockets = [];
const MessageType = {
  QUERY_LATEST:    0,
  QUERY_ALL:       1,
  RESPONSE_CHAIN:  2
};

function initP2PServer() {
  const server = new WebSocket.Server({ port: p2p_port });
  server.on('connection', ws => initConnection(ws));
  console.log('Listening P2P on port:', p2p_port);
}

function initConnection(ws) {
  sockets.push(ws);
  initMessageHandler(ws);
  initErrorHandler(ws);
  write(ws, queryChainLengthMsg());
}

function initMessageHandler(ws) {
  ws.on('message', data => {
    const message = JSON.parse(data);
    switch (message.type) {
      case MessageType.QUERY_LATEST:
        write(ws, responseLatestMsg());
        break;
      case MessageType.QUERY_ALL:
        write(ws, responseChainMsg());
        break;
      case MessageType.RESPONSE_CHAIN:
        handleBlockchainResponse(message);
        break;
    }
  });
}

function initErrorHandler(ws) {
  const closeConn = () => {
    sockets.splice(sockets.indexOf(ws), 1);
  };
  ws.on('close', closeConn);
  ws.on('error', closeConn);
}

function handleBlockchainResponse(message) {
  const received = JSON.parse(message.data);
  received.sort((b1, b2) => b1.index - b2.index);
  const latestReceived = received[received.length - 1];
  const latestHeld     = blockchain[blockchain.length - 1];

  if (latestReceived.index > latestHeld.index) {
    console.log(`Blockchain possibly behind. We: ${latestHeld.index}, Peer: ${latestReceived.index}`);
    if (latestHeld.hash === latestReceived.previousHash) {
      console.log('Appending received block');
      blockchain.push(latestReceived);
      broadcast(responseLatestMsg());
    } else if (received.length === 1) {
      console.log('Querying entire chain from peer');
      broadcast(queryAllMsg());
    } else {
      console.log('Received longer chain. Replacing.');
      replaceChain(received);
    }
  } else {
    console.log('Received blockchain not longer. Do nothing.');
  }
}

function connectToPeers(newPeers) {
  newPeers.forEach(peer => {
    const ws = new WebSocket(peer);
    ws.on('open', () => initConnection(ws));
    ws.on('error', () => console.log('Connection failed:', peer));
  });
}

function write(ws, message) {
  ws.send(JSON.stringify(message));
}

function broadcast(message) {
  sockets.forEach(s => write(s, message));
}

// Сообщения P2P
function queryChainLengthMsg() {
  return { type: MessageType.QUERY_LATEST };
}
function queryAllMsg() {
  return { type: MessageType.QUERY_ALL };
}
function responseChainMsg() {
  return { type: MessageType.RESPONSE_CHAIN, data: JSON.stringify(blockchain) };
}
function responseLatestMsg() {
  return { type: MessageType.RESPONSE_CHAIN, data: JSON.stringify([blockchain[blockchain.length - 1]]) };
}

// HTTP‑сервер для клиентов и Postman
function initHttpServer() {
  const app = express();
  app.use(bodyParser.json());

  app.get('/blocks', (req, res) => res.send(JSON.stringify(blockchain)));
  app.get('/peers',  (req, res) => res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort)));

  app.post('/mineBlock', (req, res) => {
    const newBlock = mineBlock(req.body.data);
    addBlock(newBlock);
    broadcast(responseLatestMsg());
    console.log('Block added:', newBlock);
    res.send(newBlock);
  });

  app.post('/addPeer', (req, res) => {
    connectToPeers([req.body.peer]);
    res.send();
  });

  app.listen(http_port, () => console.log('HTTP server listening on port:', http_port));
}

// Запуск
initHttpServer();
initP2PServer();
connectToPeers(initialPeers);
