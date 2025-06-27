// ✅ 修正済み client.js 全文（読み札アニメーション対応 & 表示速度反映）

window.onerror = function (msg, src, line, col, err) {
  const div = document.createElement("div");
  div.style = "position: fixed; top: 0; left: 0; background: red; color: white; padding: 10px; z-index: 9999; font-size: 14px;";
  div.textContent = `[JavaScriptエラー] ${msg} (${src}:${line})`;
  document.body.appendChild(div);
};

let socket = io();
let playerName = "";
let groupId = "";
let locked = false;
let showSpeed = 2000;
let numCards = 5;
let maxQuestions = 10;
let loadedCards = [];
let yomifudaAnimating = false;
let lastYomifudaText = "";
let playerNameFixed = false;

function animateYomifuda(text, targetDiv, speed) {
  let i = 0;
  yomifudaAnimating = true;
  const interval = setInterval(() => {
    if (i >= text.length) {
      clearInterval(interval);
      yomifudaAnimating = false;
      socket.emit("read_done", groupId);
    } else {
      targetDiv.textContent += text.slice(i, i + 5);
      i += 5;
    }
  }, speed);
}

function showCSVUploadUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h2>CSVをアップロードしてください</h2>
    <input type="file" id="csvFile" accept=".csv" />
    <br/><br/>
    <button id="csvSubmit">CSV決定</button>
  `;
  document.getElementById("csvSubmit").onclick = () => {
    const file = document.getElementById("csvFile").files[0];
    if (!file) {
      alert("CSVを選択してください");
      return;
    }
    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const rows = result.data;
        const dataRows = rows.slice(1);
        loadedCards = dataRows.map((r) => ({
          number: String(r[0]).trim(),
          term: String(r[1]).trim(),
          text: String(r[2]).trim()
        })).filter(card => card.term && card.text);
        showSettingsUI();
      }
    });
  };
}

function showSettingsUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h2>設定</h2>
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label><br/>
    <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label><br/>
    <label>表示速度(ms/5文字): <input type="number" id="speed" value="2000" min="100" max="5000" /></label><br/><br/>
    <button onclick="submitSettings()">設定を確定</button>
  `;
}

function submitSettings() {
  maxQuestions = Number(document.getElementById("maxQuestions").value || 10);
  numCards = Number(document.getElementById("numCards").value || 5);
  showSpeed = Number(document.getElementById("speed").value || 2000);

  socket.emit("set_cards_and_settings", {
    cards: loadedCards,
    settings: {
      maxQuestions,
      numCards,
      showSpeed
    }
  });
}

socket.on("start_group_selection", () => {
  const root = document.getElementById("root");
  root.innerHTML = "<h2>グループを選択してください</h2><div id='groupButtons'></div>";
  const area = document.getElementById("groupButtons");
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = "グループ " + i;
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", groupId);
      showNameInputUI();
    };
    area.appendChild(btn);
  }
});

function showNameInputUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h2>プレイヤー名を入力してください</h2>
    <input type="text" id="nameInput" placeholder="プレイヤー名" />
    <button onclick="fixPlayerName()">決定</button>
    <div id="game"></div>
  `;
}

function fixPlayerName() {
  const name = document.getElementById("nameInput").value.trim();
  if (name.length === 0) {
    alert("名前を入力してください");
    return;
  }
  playerName = name;
  playerNameFixed = true;
  document.getElementById("nameInput").disabled = true;
  const gameDiv = document.getElementById("game");
  gameDiv.innerHTML = `<button id="startBtn" onclick="startGame()">スタート</button>`;
}

function startGame() {
  if (!playerNameFixed) {
    alert("プレイヤー名を決定してください");
    return;
  }
  socket.emit("start", { groupId });
}

socket.on("user_count", (count) => {
  const div = document.getElementById("userCountDisplay");
  if (div) div.textContent = `接続中: ${count}人`;
});

socket.on("state", (state) => {
  if (!state || !state.current) return;
  locked = false;
  showSpeed = state.showSpeed || 2000;
  updateGameUI(state);
});

socket.on("lock", () => {
  locked = true;
});

socket.on("end", (players) => {
  const root = document.getElementById("game");
  root.innerHTML += "<h2>ゲーム終了！</h2>";
});

function submitAnswer(number) {
  if (locked || !playerName) return;
  socket.emit("answer", { groupId, name: playerName, number });
}

function updateGameUI(state) {
  const root = document.getElementById("game");
  const myHP = state.players.find(p => p.name === playerName)?.hp ?? 20;

  root.innerHTML = `
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div id="yomifuda"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div id="scores">自分のHP: ${myHP}点</div>
    <div id="others"></div>
  `;

  const yomifudaDiv = document.getElementById("yomifuda");
  if (state.current.text !== lastYomifudaText) {
    lastYomifudaText = state.current.text;
    yomifudaDiv.textContent = "";
    animateYomifuda(state.current.text, yomifudaDiv, showSpeed);
  }

  const cardsDiv = document.getElementById("cards");
  state.current.cards.forEach((c) => {
    const div = document.createElement("div");
    div.style = "border: 1px solid #aaa; margin: 5px; padding: 10px; cursor: pointer;";
    div.innerHTML = `<div>${c.term}</div><div>${c.number}</div>`;
    if (c.correct) div.style.background = "yellow";
    if (state.misclicks.some(m => m.number === c.number)) {
      div.style.background = "#f88";
    }
    div.onclick = () => {
      if (!locked) submitAnswer(c.number);
    };
    cardsDiv.appendChild(div);
  });

  const otherDiv = document.getElementById("others");
  otherDiv.innerHTML = "<h4>他のプレイヤー:</h4><ul>" + 
    state.players.map(p => {
      const name = p.name || "(未設定)";
      const hp = typeof p.hp === "number" ? p.hp : 20;
      const hpBar = `<div style="background: #ccc; width: 100px; height: 10px;">
        <div style="background: green; height: 10px; width: ${Math.max(0, hp / 20 * 100)}%;"></div></div>`;
      return `<li>${name}: HP ${hp}点 ${hpBar}</li>`;
    }).join("") + "</ul>";
}

window.onload = showCSVUploadUI;
