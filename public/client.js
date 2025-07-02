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
let readInterval = null;
let hasAnimated = false;



window.onload = () => {
  showCSVUploadUI();
};

function showCSVUploadUI() {
  document.body.innerHTML = `
    <h2>CSVファイルをアップロード</h2>
    <input type="file" id="csvFile" accept=".csv" /><br/><br/>
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

  socket.emit("set_name", { groupId, name: playerName });

  // ゲーム開始画面に切り替え
  document.body.innerHTML = `
  <button onclick="startGame()">スタート</button>
  <div id="point-popup" class="hidden"
    style="font-size: 10em; font-weight: bold; color: red;
           position: fixed; top: 50%; left: 50%;
           transform: translate(-50%, -50%) scale(1);
           z-index: 9999; transition: none; opacity: 1;">
  </div>
  <div id="current-point" style="position: fixed; top: 10px; right: 10px; font-size: 1.5em;"></div>
  <div id="game"></div>
`;

}

function showPointPopup(point) {
  const popup = document.getElementById("point-popup");
  popup.textContent = `${point}点！`;

  // 初期表示：拡大状態
  popup.style.transition = "none";
  popup.style.transform = "translate(-50%, -50%) scale(3)";
  popup.style.opacity = "1";
  popup.classList.remove("hidden");

  // 1秒後に縮小・フェードアウト
  setTimeout(() => {
    popup.style.transition = "transform 1s ease, opacity 1s ease";
    popup.style.transform = "translate(-50%, -50%) scale(0)";
    popup.style.opacity = "0";
  }, 1000);

  // 非表示に戻す
  setTimeout(() => {
    popup.classList.add("hidden");
    popup.style.transition = "";
    popup.style.transform = "translate(-50%, -50%) scale(1)";
    popup.style.opacity = "1";
  }, 2000);
}



function startGame() {
  console.log("startGame called");
  socket.emit("start", { groupId }); // ← 不要な numCards などを送らない
}


let lastQuestionText = "";

socket.on("state", (state) => {
  console.log("📦 state 受信", state); 
  if (!state.current) return;

  // ✅ 問題が変わったときだけ初期化＆得点ポップアップ
  if (state.current.text !== lastQuestionText) {
    hasAnimated = false;
    locked = false;
    alreadyAnswered = false;
    lastQuestionText = state.current.text;

    // ✅ 得点ポップアップ（1回のみ）
    const popup = document.getElementById("point-popup");
    const currentPoint = document.getElementById("current-point");
    if (popup && currentPoint && typeof state.current.point === "number") {
      showPointPopup(state.current.point);
      currentPoint.textContent = `${state.current.point}点`;
    }
  }

  // 🛑 game がなければ何もしない
  if (!document.getElementById("game")) return;

  updateUI(state);
});



socket.on("lock", () => {
  locked = true;
});

socket.on("end", (ranking) => {
  const game = document.getElementById("game");
  game.innerHTML = `<h2>🎉 ゲーム終了！</h2><ol style="font-size: 1.5em;">${
    ranking.map(p => `<li>${p.name}（HP: ${p.hp}）</li>`).join("")
  }</ol><button id="nextGameBtn" style="margin-top:20px;font-size:1.2em;padding:10px 20px;">次のゲームへ</button>`;

  // 次のゲームへボタンのイベント（今は機能なし）
  document.getElementById("nextGameBtn").onclick = () => {
    console.log("▶ 次のゲームボタンが押されました（まだ何もしない）");
  };
});


function updateUI(state) {
  console.log("🎯 updateUI called", state); // ← 追加
  const game = document.getElementById("game");
  game.innerHTML = `
  <div><strong>問題 ${state.questionCount} / 15</strong></div>
    <div id="yomifuda"></div>
    <div id="cards" style="display: flex; flex-wrap: wrap;"></div>
  `;
   const myHP = getMyHP(state);
const myHPPercent = Math.max(0, myHP / 20 * 100);
let myHPColor = "green";
if (myHP <= 5) myHPColor = "red";
else if (myHP <= 10) myHPColor = "yellow";

game.innerHTML += `
  <div style="margin-top:10px;">
    <h4>自分</h4>
    <div style="font-size: 1.5em;">HP: ${myHP}</div>
    <div style="background: #ccc; width: 200px; height: 20px;">
      <div style="background: ${myHPColor}; width: ${myHPPercent}%; height: 100%;"></div>
    </div>
  </div>
  <div id="others"></div>
`;


if (!hasAnimated && state.current && state.current.text) {
  animateText("yomifuda", state.current.text, showSpeed);
  hasAnimated = true;
} else if (hasAnimated && state.current && state.current.text) {
  const yomifuda = document.getElementById("yomifuda");
  if (yomifuda && yomifuda.textContent !== state.current.text) {
    yomifuda.textContent = state.current.text;
  }
}


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

  // 色付けと名前表示
  if (c.correct) {
    div.style.background = "yellow";
    div.innerHTML += `<div style="margin-top:5px;font-size:0.8em;">${c.chosenBy}</div>`;
  } else if (c.incorrect) {
    div.style.background = "red";
    div.innerHTML += `<div style="margin-top:5px;font-size:0.8em;">${c.chosenBy}</div>`;
  }

  // 内容（上に書くことで常時表示）
  div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${c.term}</div><div style="color:#666;">${c.number}</div>` + div.innerHTML;

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
    let hpColor = "green";
    if (p.hp <= 5) hpColor = "red";
    else if (p.hp <= 10) hpColor = "yellow";

    otherDiv.innerHTML += `
      <div style="margin-top:10px;">
        <strong>${p.name}</strong>
        <div style="font-size: 1.5em;">HP: ${p.hp}</div>
        <div style="background: #ccc; width: 200px; height: 20px;">
          <div style="background: ${hpColor}; width: ${hpPercent}%; height: 100%;"></div>
        </div>
      </div>
    `;
  }
});
// updateUI(state) の中のどこか（たとえば最下部）に追加
const existingTimer = document.getElementById("countdown-timer");
if (!existingTimer) {
  const timerDiv = document.createElement("div");
  timerDiv.id = "countdown-timer";
  timerDiv.style.position = "fixed";
  timerDiv.style.bottom = "10px";
  timerDiv.style.right = "10px";
  timerDiv.style.fontSize = "1.5em";
  timerDiv.style.background = "white";
  timerDiv.style.border = "1px solid #ccc";
  timerDiv.style.padding = "5px 10px";
  timerDiv.style.borderRadius = "10px";
  timerDiv.style.boxShadow = "2px 2px 5px rgba(0,0,0,0.2)";
  document.body.appendChild(timerDiv);
}


}

function getMyHP(state) {
  return state.players.find(p => p.name === playerName)?.hp ?? 20;
}

function submitAnswer(number) {
  if (locked || alreadyAnswered) {
    console.log("回答ブロック中");
    return;
  }
  console.log("✅ 回答送信", number);
  socket.emit("answer", { groupId, name: playerName, number });
  alreadyAnswered = true;
  hasAnimated = true; // 🔧 追加：アニメーションを止めないため
}



function animateText(elementId, text, speed) {
  const element = document.getElementById(elementId);
  let i = 0;
  element.textContent = "";

  if (readInterval) clearInterval(readInterval);

  readInterval = setInterval(() => {
    element.textContent = text.slice(0, i);
    i += 5;
    if (i >= text.length) {
      element.textContent = text;
      clearInterval(readInterval);
      readInterval = null;

      socket.emit("read_done", groupId); // ✅ ここでemitされてるか
    }
  }, speed);

  // animateText の全文表示後（全文出たとき）に次を追加
let countdown = 30;
const timer = document.getElementById("countdown-timer");
if (timer) timer.textContent = `⏳ ${countdown}s`;
const intervalId = setInterval(() => {
  countdown--;
  if (timer) timer.textContent = `⏳ ${countdown}s`;
  if (countdown <= 0) {
    clearInterval(intervalId);
    if (timer) timer.textContent = "";
  }
}, 1000);


}
