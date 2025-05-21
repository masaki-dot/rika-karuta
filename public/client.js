let socket = io();
let playerName = "";
let locked = false;
let loadedCards = [];

function initUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h1>理科カルタ（リアルタイム）</h1>
    <input type="text" id="nameInput" placeholder="プレイヤー名を入力" />
    <input type="file" id="csvFile" accept=".csv" />
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label>
    <button onclick="loadAndStart()">スタート</button>
    <div id="game"></div>
  `;
}

function loadAndStart() {
  playerName = document.getElementById("nameInput").value.trim();
  const file = document.getElementById("csvFile").files[0];
  const maxQuestions = Number(document.getElementById("maxQuestions").value);
  if (!playerName || !file) {
    alert("プレイヤー名とCSVを入力してください");
    return;
  }

  Papa.parse(file, {
    header: true,
    complete: (result) => {
      loadedCards = result.data.filter(r => r['番号'] && r['用語'] && r['説明']).map(r => ({
        number: r['番号'],
        term: r['用語'],
        text: r['説明']
      }));
      socket.emit("start", {
        cards: loadedCards,
        numCards: 5,
        maxQuestions: maxQuestions
      });
    }
  });
}

socket.on("state", (state) => {
  const current = state.current;
  if (!current) return;

  const root = document.getElementById("game");
  root.innerHTML = `
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div style="font-size: 1.2em; margin: 10px;">${current.text}</div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div>得点: ${getMyScore(state.players)}点</div>
    <input type="text" id="answerInput" placeholder="札の番号を入力" />
    <button onclick="submitAnswer()">送信</button>
    <button onclick="resetGame()">リセット</button>
  `;

  const cardsDiv = document.getElementById("cards");
  current.cards.forEach((c) => {
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
  document.getElementById("game").innerHTML += `<h2>ゲーム終了！</h2>`;
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

window.onload = initUI;
