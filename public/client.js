// ✅ 完全修正版 client.js

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
let readAloud = false;
let showSpeed = 2000;
let numCards = 5;
let maxQuestions = 10;
let loadedCards = [];
let yomifudaAnimating = false;
let lastYomifudaText = "";
let playerNameFixed = false;

function showGroupSelectUI() {
  const root = document.getElementById("root");
  root.innerHTML = `
    <h2>CSVをアップロードして、グループを選んでください</h2>
    <input type="file" id="csvFile" accept=".csv" />
    <br/><br/>
    <label>問題数: <input type="number" id="maxQuestions" value="10" min="1" /></label>
    <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label>
    <label>表示速度(ms/5文字): <input type="number" id="speed" value="2000" min="100" max="5000" /></label>
    <label><input type="checkbox" id="readAloudCheck" /> 読み札を読み上げる</label>
    <br/><br/>
    <div id="groupButtons"></div>
    <div id="userCountDisplay" style="position: fixed; top: 10px; right: 10px; background: #eee; padding: 5px 10px; border-radius: 8px;">接続中: 0人</div>
  `;

  document.getElementById("csvFile").addEventListener("change", () => {
    const file = document.getElementById("csvFile").files[0];
Papa.parse(file, {
  header: false, // ヘッダーを使わず、1行目を手動で扱う
  skipEmptyLines: true,
  complete: (result) => {
    const rows = result.data;

    if (rows.length < 2) {
      alert("CSVファイルに十分な行がありません。");
      return;
    }

    // 1行目を列名として使い、2行目以降をデータとして扱う
    const dataRows = rows.slice(1); // ← ここが重要！

    loadedCards = dataRows.map((r, i) => {
      return {
        number: String(r[0]).trim(), // 番号
        term: String(r[1]).trim(),   // 用語
        text: String(r[2]).trim()    // 説明
      };
    }).filter(card => card.term && card.text); // 空白行除外

    console.log("📥 読み込んだ問題数:", loadedCards.length);
    console.log("📤 サーバーに送信する冒頭5件:", loadedCards.slice(0, 5));

    socket.emit("set_cards", loadedCards);
    drawGroupButtons();
  },
  error: (err) => {
    console.error("🚨 CSV読み込みエラー:", err);
  }
});



  });
}

function drawGroupButtons() {
  const area = document.getElementById("groupButtons");
  area.innerHTML = "<h3>グループを選択</h3>";
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = "グループ " + i;
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", groupId);
      initUI();
    };
    area.appendChild(btn);
  }
}

function initUI() {
  const root = document.getElementById("root");
  playerNameFixed = false;
  root.innerHTML = `
    <h1>理科カルタ（リアルタイム）</h1>
    <input type="text" id="nameInput" placeholder="プレイヤー名を入力" />
    <button onclick="fixPlayerName()">決定</button>
    <br/><br/>
    <label>問題数: <input type="number" id="maxQuestions" value="${maxQuestions}" min="1" /></label>
    <label>取り札の数: <input type="number" id="numCards" value="${numCards}" min="5" max="10" /></label>
    <label>表示速度(ms/5文字): <input type="number" id="speed" value="${showSpeed}" min="100" max="5000" /></label>
    <label><input type="checkbox" id="readAloudCheck" ${readAloud ? "checked" : ""} /> 読み札を読み上げる</label>
    <br/><br/>
    <button id="startBtn" onclick="startGame()" disabled>スタート</button>
    <button onclick="showGroupSelectUI()">グループ選択に戻る</button>
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
  document.getElementById("startBtn").disabled = false;
}

function startGame() {
  if (!playerNameFixed) {
    alert("プレイヤー名を決定してください");
    return;
  }

  readAloud = document.getElementById("readAloudCheck")?.checked || false;
  showSpeed = Number(document.getElementById("speed")?.value || 2000);
  numCards = Number(document.getElementById("numCards")?.value || 5);
  maxQuestions = Number(document.getElementById("maxQuestions")?.value || 10);

  socket.emit("start", {
    groupId,
    numCards,
    maxQuestions
  });
}

socket.on("csv_ready", () => {
  drawGroupButtons();
});

socket.on("user_count", (count) => {
  const div = document.getElementById("userCountDisplay");
  if (div) div.textContent = `接続中: ${count}人`;
});

socket.on("state", (state) => {
  window.__alreadyReadDone__ = false;
  const current = state.current;
  if (!current) return;

  locked = false;
  const root = document.getElementById("game");
  root.innerHTML = `
    <div><strong>問題 ${state.questionCount} / ${state.maxQuestions}</strong></div>
    <div id="yomifuda" style="font-size: 1.2em; margin: 10px; text-align: left;"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap; justify-content: center;"></div>
    <div id="scores">得点: ${getMyScore(state.players)}点</div>
    <div id="others"></div>
  `;

  yomifudaAnimating = false;
  lastYomifudaText = "";

  const yomifudaDiv = document.getElementById("yomifuda");
if (yomifudaDiv) {
  // すでに同じ問題文が表示中なら再表示しない
  if (!yomifudaAnimating && lastYomifudaText !== current.text) {
    yomifudaDiv.textContent = "";
    setTimeout(() => {
      showYomifudaAnimated(current.text);
    }, 100);
    lastYomifudaText = current.text;
  }
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
    state.players.map(p => `<li>${p.name || "(未設定)"}: ${p.score}点</li>`).join("") + "</ul>";

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
    sorted.map(p => `<li>${p.name}: ${p.score}点</li>`).join('') +
    `</ol>`;
});

function submitAnswer(number) {
  if (locked || !playerName) return;
  socket.emit("answer", { groupId, name: playerName, number });
}

function getMyScore(players) {
  const me = players.find((p) => p.name === playerName);
  return me ? me.score : 0;
}

function showYomifudaAnimated(text) {
  if (yomifudaAnimating) return;
  yomifudaAnimating = true;
  const div = document.getElementById("yomifuda");
  div.textContent = "";
  div.style.textAlign = "left";
  let i = 0;
  speechSynthesis.cancel();

  const interval = setInterval(() => {
    const chunk = text.slice(i, i + 5);
    div.textContent += chunk;
    i += 5;
    if (i >= text.length) {
      clearInterval(interval);
      yomifudaAnimating = false;
      if (groupId && !window.__alreadyReadDone__) {
        window.__alreadyReadDone__ = true;
        socket.emit("read_done", groupId);
      }
    }
  }, showSpeed);

  if (readAloud && window.speechSynthesis) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    speechSynthesis.speak(utter);
  }
}

window.onload = function () {
  showGroupSelectUI();
};
