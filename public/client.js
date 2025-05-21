let socket = io();
let playerName = prompt("プレイヤー名を入力してください");
let locked = false;

let cards = [];
let answer = "";
let displayText = "";
let score = 0;

socket.on("state", (state) => {
  const root = document.getElementById("root");
  const current = state.current;
  if (!current) return;

  cards = current.cards;
  answer = current.answer;
  displayText = current.text;

  root.innerHTML = `
    <h1>理科カルタ</h1>
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div style="font-size: 1.2em; margin: 10px;">${displayText}</div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div>得点: ${getMyScore(state.players)}点</div>
    <input type="text" id="answerInput" placeholder="札の番号を入力" />
    <button onclick="submitAnswer()">送信</button>
    <button onclick="resetGame()">リセット</button>
  `;
  const cardsDiv = document.getElementById("cards");
  cards.forEach((c) => {
    const div = document.createElement("div");
    div.style = "border: 1px solid #aaa; margin: 5px; padding: 10px;";
    div.innerHTML = `<div>${c.term}</div><div>${c.number}</div>`;
    if (c.correct) div.style.background = "yellow";
    cardsDiv.appendChild(div);
  });

  const input = document.getElementById("answerInput");
  if (locked) {
    input.disabled = true;
    input.style.background = "#fdd";
  } else {
    input.disabled = false;
    input.style.background = "white";
  }
});

socket.on("lock", (name) => {
  if (name === playerName) {
    locked = true;
    setTimeout(() => {
      locked = false;
    }, 3000);
  }
});

socket.on("end", () => {
  document.getElementById("root").innerHTML += `<h2>ゲーム終了！</h2>`;
});

function submitAnswer() {
  if (locked) return;
  const number = document.getElementById("answerInput").value.trim();
  socket.emit("answer", { name: playerName, number });
  document.getElementById("answerInput").value = "";
}

function resetGame() {
  socket.emit("reset");
}

function getMyScore(players) {
  const me = players.find((p) => p.name === playerName);
  return me ? me.score : 0;
}

