
let socket = io();
let playerName = "";
let locked = false;
let loadedCards = [];
let readAloud = false;
let showSpeed = 40;
let previousText = "";
let numCards = 5;

function initUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h1>理科カルタ（リアルタイム）</h1>
    <input type="text" id="nameInput" placeholder="プレイヤー名を入力" />
    <input type="file" id="csvFile" accept=".csv" />
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label>
    <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label>
    <label>表示速度(ms/文字): <input type="number" id="speed" value="40" min="10" max="200" /></label>
    <label><input type="checkbox" id="readAloudCheck" /> 読み札を読み上げる</label>
    <button onclick="loadAndStart()">スタート</button>
    <div id="game"></div>
  `;
}

function loadAndStart() {
  playerName = document.getElementById("nameInput").value.trim();
  const file = document.getElementById("csvFile").files[0];
  const maxQuestions = Number(document.getElementById("maxQuestions").value);
  readAloud = document.getElementById("readAloudCheck").checked;
  showSpeed = Number(document.getElementById("speed").value);
  numCards = Number(document.getElementById("numCards").value);

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
        numCards: numCards,
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
    <div id="yomifuda" style="font-size: 1.2em; margin: 10px; text-align: left;"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div id="scores">得点: ${getMyScore(state.players)}点</div>
    <input type="text" id="answerInput" placeholder="札の番号を入力" />
    <button onclick="submitAnswer()">送信</button>
    <button onclick="resetGame()">リセット</button>
    <div id="others"></div>
  `;

  showYomifudaAnimated(current.text);
  previousText = current.text;

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

  const otherDiv = document.getElementById("others");
  otherDiv.innerHTML = "<h4>他のプレーヤー:</h4><ul>" + state.players.map(p => `<li>${p.name}: ${p.score}点</li>`).join("") + "</ul>";
});

socket.on("lock", (name) => {
  if (name === playerName) {
    locked = true;
    const input = document.getElementById("answerInput");
    if (input) {
      input.disabled = true;
      input.style.background = "#fdd";
    }
    setTimeout(() => {
      locked = false;
      if (input) {
        input.disabled = false;
        input.style.background = "white";
      }
    }, 3000);
  }
});

socket.on("end", (players) => {
  const root = document.getElementById("game");
  root.innerHTML += `<h2>ゲーム終了！</h2>`;
  const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, 5);
  root.innerHTML += `<h3>順位</h3><ol>` + sorted.map(p => `<li>${p.name}：${p.score}点</li>`).join('') + `</ol>`;
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

function showYomifudaAnimated(text) {
  const yomifudaDiv = document.getElementById("yomifuda");
  yomifudaDiv.textContent = "";
  yomifudaDiv.style.textAlign = "left";
  let i = 0;
  const interval = setInterval(() => {
    yomifudaDiv.textContent += text[i];
    i++;
    if (i >= text.length) clearInterval(interval);
  }, showSpeed);

  if (readAloud && window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    speechSynthesis.speak(utter);
  }
}

window.onload = initUI;
