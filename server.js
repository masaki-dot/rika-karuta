const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

let state = {
  players: [],
  current: null,
  cards: [],
  questionCount: 0,
  maxQuestions: 10,
};

io.on('connection', (socket) => {
  socket.on('start', ({ cards, numCards, maxQuestions }) => {
    state.cards = [...cards];
    state.maxQuestions = maxQuestions;
    state.players = [];
    state.questionCount = 0;
    nextQuestion(io);
  });

  socket.on('answer', ({ name, number }) => {
    if (!state.players.find(p => p.name === name)) {
      state.players.push({ name, score: 0 });
    }
    if (state.current && !state.current.answered) {
      if (state.current.answer === number) {
        const player = state.players.find(p => p.name === name);
        player.score++;
        state.current.answered = true;
        state.current.cards = state.current.cards.map(c => ({
          ...c,
          correct: c.number === number
        }));
        io.emit('state', state);
        setTimeout(() => {
          if (state.questionCount < state.maxQuestions) {
            nextQuestion(io);
          } else {
            io.emit('end');
          }
        }, 3000);
      } else {
        io.emit('lock', name);
      }
    }
  });

  socket.on('reset', () => {
    state = {
      players: [],
      current: null,
      cards: [],
      questionCount: 0,
      maxQuestions: 10,
    };
    io.emit('state', state);
  });
});

function nextQuestion(io) {
  const pool = [...state.cards];
  const selected = [];
  const terms = new Set();
  while (selected.length < 5 && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    const c = pool.splice(i, 1)[0];
    if (!terms.has(c.term)) {
      terms.add(c.term);
      selected.push(c);
    }
  }
  const i = Math.floor(Math.random() * selected.length);
  state.current = {
    cards: selected,
    answer: selected[i].number,
    text: selected[i].text,
    display: '',
    answered: false,
  };
  state.questionCount++;
  io.emit('state', state);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
