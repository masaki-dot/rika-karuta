// public/client.js

let socket = io();
let playerName = "";
let groupId = "";
let showSpeed = 2000;
let numCards = 5;
let maxQuestions = 10;
let loadedCards = [];
let locked = false;
let alreadyAnswered = false;

window.onload = () => {
  showCSVUploadUI();
};

function showCSVUploadUI() {
  document.body.innerHTML = `
    <h2>CSVファイルをアップロード</h2>
    <input type="file" id="csvFile" accept=".csv" /><br/><br/>
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label><br/>
    <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label><br/>
    <label>表示速度(ms/5文字): <input type="number" id="speed" value="2000" min="100" /></label><br/><br/>
  `;
  const input = document.createElement("button");
  input.textContent = "決定してグループ選択へ";
  input.onclick = handleCSVUpload;
  document.body.appendChild(input);
}

function handleCSVUpload() {
  const file = document.getElementById("csvFile").files[0];
  if (!file) return alert("CSVファイルを選んでください");

  Papa.parse(file, {
    header: false,
    skipEmptyLines: true,
    complete: (result) => {
      const rows = result.data;
      loadedCards = rows.slice(1).map(r => ({
        number: String(r[0]).trim(),
        term: String(r[1]).trim(),
        text: String(r[2]).trim()
      })).filter(c => c.term && c.text);

      maxQuestions = parseInt(document.getElementById("maxQuestions").value);
      numCards = parseInt(document.getElementById("numCards").value);
      showSpeed = parseInt(document.getElementById("speed").value);

      socket.emit("set_cards_and_settings", {
        cards: loadedCards,
        settings: { maxQuestions, numCards, showSpeed }
      });
    }
  });
}

socket.on("start_group_selection", () => {
  document.body.innerHTML = `<h2>グループを選択してください</h2>`;
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = `グループ ${i}`;
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", groupId);
      showNameInputUI();
    };
    document.body.appendChild(btn);
  }
});

function showNameInputUI() {
  document.body.innerHTML = `
    <h2>プレイヤー名を入力</h2>
    <input id="nameInput" /><button onclick="fixName()">決定</button>
  `;
}

function fixName() {
  playerName = document.getElementById("nameInput").value.trim();
  if (!playerName) return alert("名前を入力してください");

  document.body.innerHTML = `<button onclick="startGame()">スタート</button><div id="game"></div>`;
}

function startGame() {
  socket.emit("start", { groupId, numCards, maxQuestions });
}

socket.on("state", (state) => {
  if (!state.current) return;
  locked = false;
  alreadyAnswered = false;
  showSpeed = state.showSpeed || 2000;
  updateUI(state);
});

socket.on("lock", () => {
  locked = true;
});

socket.on("end", (players) => {
  document.getElementById("game").innerHTML = `<h2>ゲーム終了！</h2>`;
});

function updateUI(state) {
  const game = document.getElementById("game");
  game.innerHTML = `
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div id="yomifuda"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap;"></div>
    <div>自分のHP: ${getMyHP(state)}点</div>
    <div id="others"></div>
  `;

  animateText("yomifuda", state.current.text, showSpeed);

  const cardsDiv = document.getElementById("cards");
cardsDiv.style.display = "grid";
cardsDiv.style.gridTemplateColumns = `repeat(auto-fit, minmax(120px, 1fr))`;
cardsDiv.style.gap = "10px";

state.current.cards.forEach(c => {
  const div = document.createElement("div");
  div.className = "card";
  div.style.border = "1px solid #ccc";
  div.style.padding = "10px";
  div.style.textAlign = "center";
  div.style.borderRadius = "8px";
  div.style.boxShadow = "2px 2px 5px rgba(0,0,0,0.1)";
  div.style.cursor = "pointer";
  div.style.background = "#fff";

  if (c.correct) div.style.background = "yellow";
  if (c.incorrect) div.style.background = "red";

  div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${c.term}</div><div style="color:#666;">${c.number}</div>`;
  div.onclick = () => {
    if (!locked && !alreadyAnswered) submitAnswer(c.number);
  };
  cardsDiv.appendChild(div);
});


  const otherDiv = document.getElementById("others");
  otherDiv.innerHTML = `<h4>他プレイヤー</h4>`;
  state.players.forEach(p => {
    if (p.name !== playerName) {
      const hpPercent = Math.max(0, p.hp / 20 * 100);
      otherDiv.innerHTML += `<div>${p.name} HP: ${p.hp}<div style="background: #ccc; width: 100px; height: 10px;"><div style="background: green; width: ${hpPercent}%; height: 10px;"></div></div></div>`;
    }
  });

  if (state.misclicks?.length > 0) {
    const list = state.misclicks.map(m => `${m.name}: ${m.number}`).join("<br>");
    otherDiv.innerHTML += `<div><strong>お手付き</strong><br>${list}</div>`;
  }
}

function getMyHP(state) {
  return state.players.find(p => p.name === playerName)?.hp ?? 20;
}

function submitAnswer(number) {
  socket.emit("answer", { groupId, name: playerName, number });
  alreadyAnswered = true;
}

function animateText(elementId, text, speed) {
  const element = document.getElementById(elementId);
  let i = 0;
  element.textContent = "";
  const interval = setInterval(() => {
    element.textContent = text.slice(0, i);
    i += 5;
    if (i > text.length) {
      clearInterval(interval);
      socket.emit("read_done", groupId);
    }
  }, speed);
}
