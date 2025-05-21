let socket = io();
let playerName = "";
let groupId = "";
let locked = false;
let loadedCards = [];
let readAloud = false;
let showSpeed = 2000; // 5文字ごとに表示
let numCards = 5;
let lastQuestionText = ""; // 読み札再表示防止

function showGroupSelectUI() {
  const root = document.getElementById("root");
  root.innerHTML = "<h2>グループを選んでください（1〜10）</h2>";
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = "グループ " + i;
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", groupId);
      initUI();
    };
    root.appendChild(btn);
  }
}

function initUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h1>理科カルタ（リアルタイム）</h1>
    <input type="text" id="nameInput" placeholder="プレイヤー名を入力" />
    <input type="file" id="csvFile" accept=".csv" />
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label>
    <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label>
    <label>表示速度(ms/5文字): <input type="number" id="speed" value="2000" min="500" max="5000" /></label>
    <label><input type="checkbox" id="readAloudCheck" /> 読み札を読み上げる</label>
    <button onclick="loadAndStart()">スタート</button>
    <button onclick="showGroupSelectUI()">グループ選択に戻る</button>
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

  if (!playerName || !file || !groupId) {
    alert("プレイヤー名、CSV、グループを正しく設定してください");
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
        groupId,
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

  locked = false; // 🔓 新しい問題でロック解除
  const root = document.getElementById("game");

  root.innerHTML = `
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div id="yomifuda" style="font-size: 1.2em; margin: 10px; text-align: left;"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div id="scores">得点: ${getMyScore(state.players)}点</div>
    <button onclick="resetGame()">リセット</button>
    <div id="others"></div>
  `;

  // 🔄 読み札を再表示しないように制御
  if (current.text !== lastQuestionText) {
    showYomifudaAnimated(current.text);
    lastQuestionText = current.text;
  } else {
    document.getElementById("yomifuda").textContent = current.text;
  }

  const cardsDiv = document.getElementById("cards");
  current.cards.forEach((c) => {
    const div = document.createElement("div");
    div.style = "border: 1px solid #aaa; margin: 5px; padding: 10px; cursor: pointer;";
    div.innerHTML = `<div>${c.term}</div><div>${c.number}</div>`;
    if (c.correct) div.style.background = "yellow";
    div.onclick = () => {
      if (!locked) submitAnswer(c.number);
    };
    cardsDiv.appendChild(div);
  });

  const otherDiv = document.getElementById("others");
  otherDiv.innerHTML = "<h4>他のプレーヤー:</h4><ul>" +
    state.players.map(p => `<li>${p.name}: ${p.score}点</li>`).join("") + "</ul>";

  if (state.misclicks) {
    state.misclicks.forEach(m => {
      const card = [...document.querySelectorAll("#cards div")].find(d => d.innerText.includes(m.number));
      if (card) {
        card.style.background = "#fdd";
        const tag = document.createElement("div");
        tag.style.color = "red";
        tag.textContent = `お手つき: ${m.name}`;
        card.appendChild(tag);
      }
    });
  }
});

socket.on("lock", (name) => {
  if (name === playerName) {
    locked = true;
  }
});

socket.on("end", (players) => {
  const root = document.getElementById("game");
  root.innerHTML += `<h2>ゲーム終了！</h2>`;
  const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, 5);
  root.innerHTML += `<h3>順位</h3><ol>` +
    sorted.map(p => `<li>${p.name}：${p.score}点</li>`).join('') +
    `</ol>`;
});

function submitAnswer(number) {
  if (locked) return;
  socket.emit("answer", { groupId, name: playerName, number });
}

function resetGame() {
  socket.emit("reset", groupId);
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
  speechSynthesis.cancel(); // 前の読み上げを止める

  const interval = setInterval(() => {
    const chunk = text.slice(i, i + 5);
    yomifudaDiv.textContent += chunk;
    i += 5;
    if (i >= text.length) clearInterval(interval);
  }, showSpeed);

  if (readAloud && window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    speechSynthesis.speak(utter);
  }
}

window.onload = showGroupSelectUI;
