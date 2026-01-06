const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));

let gameState = null;

function createDeck() {
  const deck = [];
  for (let i = -2; i <= 12; i++) {
    let count = 5;
    if (i === 0) count = 15;
    if (i === -1) count = 10;
    if (i === -2) count = 5;
    for (let j = 0; j < count; j++) {
      deck.push(i);
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function checkColumns(player) {
  for (let col = 0; col < 4; col++) {
    const indices = [col, col + 4, col + 8];
    const cards = indices.map(i => player.grid[i]);
    
    if (cards.every(c => c.revealed) && 
        cards[0].value === cards[1].value && 
        cards[1].value === cards[2].value) {
      indices.forEach(i => {
        player.grid[i] = { value: null, revealed: false };
      });
    }
  }
}

function calculateScore(player) {
  return player.grid.reduce((sum, card) => {
    if (card.value !== null) return sum + card.value;
    return sum;
  }, 0);
}

io.on('connection', (socket) => {
  console.log('Nouveau joueur connecté:', socket.id);

  socket.emit('gameState', gameState);

  socket.on('createGame', () => {
    const deck = createDeck();
    gameState = {
      players: [],
      deck: deck.slice(24),
      discard: [deck[23]],
      currentPlayer: 0,
      phase: 'waiting',
      turnAction: null,
      started: false,
      lastRoundTriggered: false,
      lastRoundTriggeredBy: null,
      playersFinished: []
    };
    io.emit('gameState', gameState);
  });

  socket.on('joinGame', (playerName) => {
    if (!gameState || gameState.started) {
      socket.emit('error', 'Impossible de rejoindre');
      return;
    }

    const deck = gameState.deck;
    const newPlayer = {
      id: socket.id,
      name: playerName,
      grid: Array(12).fill(null).map((_, i) => ({
        value: deck[i],
        revealed: false
      })),
      score: 0,
      hasPlayedLastRound: false
    };

    gameState.players.push(newPlayer);
    gameState.deck = deck.slice(12);

    io.emit('gameState', gameState);
    socket.emit('playerId', socket.id);
  });

  socket.on('startGame', () => {
    if (gameState && gameState.players.length >= 2) {
      gameState.phase = 'initial';
      gameState.started = true;
      io.emit('gameState', gameState);
    }
  });

  socket.on('revealInitialCard', (cardIndex) => {
    if (!gameState) return;

    const player = gameState.players.find(p => p.id === socket.id);
    if (!player) return;

    const revealedCount = player.grid.filter(c => c.revealed).length;
    if (revealedCount >= 2) return;

    player.grid[cardIndex].revealed = true;

    const allReady = gameState.players.every(p => 
      p.grid.filter(c => c.revealed).length >= 2
    );

    if (allReady) {
      gameState.phase = 'playing';
    }

    io.emit('gameState', gameState);
  });

  socket.on('drawCard', (fromDiscard) => {
    if (!gameState) return;

    const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== gameState.currentPlayer) return;
    if (gameState.turnAction) return;

    let drawnCard;
    if (fromDiscard) {
      drawnCard = gameState.discard.pop();
      gameState.turnAction = 'drew_from_discard';
    } else {
      drawnCard = gameState.deck.pop();
      gameState.turnAction = 'drew_from_deck';
    }

    socket.emit('drawnCard', drawnCard);
    io.emit('gameState', gameState);
  });

  socket.on('replaceCard', ({ cardIndex, drawnCard }) => {
    if (!gameState) return;

    const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== gameState.currentPlayer) return;

    const player = gameState.players[playerIndex];
    const oldCard = player.grid[cardIndex].value;
    
    // Remplacer la carte (peu importe si elle est révélée ou cachée)
    player.grid[cardIndex] = { value: drawnCard, revealed: true };

    checkColumns(player);

    gameState.discard.push(oldCard);

    // Vérifier si toutes les cartes sont révélées
    const allRevealed = player.grid.every(c => c.revealed || c.value === null);
    
    if (allRevealed && !gameState.lastRoundTriggered) {
      // Déclencher le dernier tour
      gameState.lastRoundTriggered = true;
      gameState.lastRoundTriggeredBy = socket.id;
      player.hasPlayedLastRound = true;
    }

    // Marquer que ce joueur a joué son dernier tour si applicable
    if (gameState.lastRoundTriggered) {
      player.hasPlayedLastRound = true;
    }

    // Passer au joueur suivant
    gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    gameState.turnAction = null;

    // Vérifier si tous les joueurs ont joué leur dernier tour
    if (gameState.lastRoundTriggered && gameState.players.every(p => p.hasPlayedLastRound)) {
      gameState.phase = 'finished';
    }

    io.emit('gameState', gameState);
  });

  socket.on('discardDrawnCard', ({ cardIndex, drawnCard }) => {
    if (!gameState) return;
    if (gameState.turnAction !== 'drew_from_deck') return;

    const playerIndex = gameState.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== gameState.currentPlayer) return;

    const player = gameState.players[playerIndex];
    
    // Retourner une carte cachée
    player.grid[cardIndex].revealed = true;

    checkColumns(player);

    gameState.discard.push(drawnCard);

    // Vérifier si toutes les cartes sont révélées
    const allRevealed = player.grid.every(c => c.revealed || c.value === null);
    
    if (allRevealed && !gameState.lastRoundTriggered) {
      gameState.lastRoundTriggered = true;
      gameState.lastRoundTriggeredBy = socket.id;
      player.hasPlayedLastRound = true;
    }

    if (gameState.lastRoundTriggered) {
      player.hasPlayedLastRound = true;
    }

    gameState.currentPlayer = (gameState.currentPlayer + 1) % gameState.players.length;
    gameState.turnAction = null;

    if (gameState.lastRoundTriggered && gameState.players.every(p => p.hasPlayedLastRound)) {
      gameState.phase = 'finished';
    }

    io.emit('gameState', gameState);
  });

  socket.on('resetGame', () => {
    gameState = null;
    io.emit('gameState', gameState);
  });

  socket.on('disconnect', () => {
    console.log('Joueur déconnecté:', socket.id);
    
    if (gameState) {
      gameState.players = gameState.players.filter(p => p.id !== socket.id);
      
      if (gameState.players.length === 0) {
        gameState = null;
      }
      
      io.emit('gameState', gameState);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`🎮 Serveur Skyjo démarré sur http://localhost:${PORT}`);
});