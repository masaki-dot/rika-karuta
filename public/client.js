// public/client.js

let socket = io();
let isHost = false;
let countdownIntervalId = null;
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
  showGroupSelectionUI();  // ← 直接関数を呼び出すだけにする
});

function showNameInputUI() {
  document.body.innerHTML = `
    <h2>プレイヤー名を入力</h2>
    <input id="nameInput" />
    <button onclick="fixName()">決定</button><br/><br/>
    <button onclick="backToGroupSelection()">グループ選択に戻る</button>
  `;
}


function fixName() {
  playerName = document.getElementById("nameInput").value.trim();
  if (!playerName) return alert("名前を入力してください");

  socket.emit("set_name", { groupId, name: playerName });

  // ゲーム開始画面に切り替え
 showStartUI();  // スタート画面を関数で表示（次ステップで作る）


}

function showStartUI() {
  document.body.innerHTML = `
    <h2>🎮 ゲームのルール</h2>
    <div style="text-align:left; font-size:1.1em; line-height:1.6;">
      <p><strong style="color:darkred;">🩸 HPが0になると脱落！</strong><br>
         回答を間違えると、その問題のポイント分だけHPが減ります。</p>

      <p><strong style="color:green;">✅ 正解すると得点ゲット</strong><br>
         ・1問正解ごとに <strong style="color:green;">＋10点</strong><br>
         ・さらに最後の1人なら <strong style="color:gold;">＋200点</strong><br>
         ・2番目に脱落しなかった人には <strong style="color:orange;">＋100点</strong></p>

      <p><strong style="color:crimson;">⚠ 他のプレイヤーに減点効果</strong><br>
         自分が正解すると、他の全員のHPがその問題の点数分減ります。</p>

      <p><strong style="color:gray;">📉 不正解は自分だけが減点</strong><br>
         他の人に影響せず、自分のHPだけが減ります。</p>
    </div>

    ${isHost
      ? `<p style="color:gray;">※ホストがゲームを開始します</p>`
      : `<button onclick="startGameUI()" style="margin-top:20px; font-size:1.2em;">スタート</button>`}
  `;
}


function startGameUI() {
  if (isHost) {
    socket.emit("host_start");
  } else {
    alert("ホストがゲームを開始します。");
    return;
  }

  document.body.innerHTML = `
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

function backToGroupSelection() {
  groupId = "";
  showGroupSelectionUI();  // ← 次の②で定義する関数をここで使う
}

function showGroupSelectionUI() {
  document.body.innerHTML = `<h2>グループを選択してください</h2>`;
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = `グループ ${i}`;
    btn.onclick = () => {
      isHost = false;
      groupId = "group" + i;
      socket.emit("join", groupId);
      showNameInputUI();
    };
    document.body.appendChild(btn);
  }

  // ✅ ホストボタンを追加
  const hostBtn = document.createElement("button");
  hostBtn.textContent = "👑 ホストとして参加";
  hostBtn.style.marginTop = "20px";
  hostBtn.onclick = () => {
    isHost = true;
    socket.emit("host_join");  // サーバーにホストとして通知
    showHostUI();
  };
  document.body.appendChild(document.createElement("br"));
  document.body.appendChild(hostBtn);
}

function showHostUI() {
  document.body.innerHTML = `
    <h2>👑 ホスト画面</h2>
    <div style="display:flex;">
      <div id="hostStatus" style="flex:1;"></div>
      <div id="globalRanking" style="flex:1; padding-left:20px;"></div>
    </div>

    <h3>🔀 グループ割り振り設定</h3>
    <label>グループ数：<input id="groupCount" type="number" value="5" min="2" max="10"></label><br/>
    <label>各グループの人数：<input id="playersPerGroup" type="number" value="3" min="1"></label><br/>
    <label>上位何グループにスコア上位を集中させるか：<input id="topGroupCount" type="number" value="1" min="1" max="2"></label><br/>
    <button onclick="submitGrouping()" style="margin-top:10px;">グループ割り振りを実行</button>

    <hr/>

    <button onclick="hostStartAllGroups()" style="margin-top:20px;font-size:1.2em;">全グループでゲーム開始</button>
  `;

  socket.emit("host_request_state");
  socket.emit("request_global_ranking");
  setInterval(() => {
    socket.emit("host_request_state");
    socket.emit("request_global_ranking");
  }, 2000);
}



function hostStartAllGroups() {
  socket.emit("host_start");
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

  showSpeed = state.showSpeed;

  if (!state.current) return;

  // 💡 必ずゲーム画面が表示されるようにここで描画（条件を外す）
  if (!document.getElementById("game")) {
  document.body.innerHTML = `
    <div id="point-popup" class="hidden"
      style="font-size: 10em; font-weight: bold; color: red;
             position: fixed; top: 50%; left: 50%;
             transform: translate(-50%, -50%) scale(1);
             z-index: 9999; transition: none; opacity: 1;">
    </div>

    <div id="current-point"
      style="position: fixed; top: 10px; right: 10px; font-size: 1.5em;">
    </div>

    <div id="game"></div>
  `;
}

  // 得点ポップアップと右上表示
if (state.current.pointValue != null) {
  const popup = document.getElementById("point-popup");
  popup.textContent = `${state.current.pointValue}点`;
  popup.classList.remove("hidden");

  // 拡大表示 → 縮小フェード → 非表示
  popup.style.transition = "none";
  popup.style.transform = "translate(-50%, -50%) scale(3)";
  popup.style.opacity = "1";

  setTimeout(() => {
    popup.style.transition = "transform 1s ease, opacity 1s ease";
    popup.style.transform = "translate(-50%, -50%) scale(0)";
    popup.style.opacity = "0";
  }, 1000);

  setTimeout(() => {
    popup.classList.add("hidden");
    popup.style.transition = "";
    popup.style.transform = "translate(-50%, -50%) scale(1)";
    popup.style.opacity = "1";
  }, 2000);

  // 右上の得点表示
  const currentPointDiv = document.getElementById("current-point");
  if (currentPointDiv) {
    currentPointDiv.textContent = `この問題：${state.current.pointValue}点`;
  }
}

  
  // ✅ 問題が新しくなった時のみフラグを更新
  if (state.current.text !== lastQuestionText) {
    hasAnimated = false;
    locked = false;
    alreadyAnswered = false;
    lastQuestionText = state.current.text;
  }

  // ✅ 必ずUI更新（上の if 文の外にする）
  updateUI(state);
});

socket.on("global_ranking", (ranking) => {
  const div = document.getElementById("globalRanking");
  if (!div) return;

  div.innerHTML = `<h3>🌏 全体ランキング</h3><ol style="font-size:1.1em;">${
    ranking.map(p =>
      `<li>${p.name}（累計: ${p.totalScore}点）</li>`
    ).join("")
  }</ol>`;
});


socket.on("host_state", (allGroups) => {
  const div = document.getElementById("hostStatus");
  if (!div) return;

  div.innerHTML = Object.entries(allGroups).map(([group, data]) => {
    const isLocked = data.locked;  // ← ここで取得
    const groupColor = isLocked ? "red" : "black";  // ← 色分け

    const members = data.players.map(p => {
      const extra = p.hp != null ? `｜HP: ${p.hp}｜正解数: ${p.correctCount ?? 0}` : "";
      return `<li>${p.name}${extra}</li>`;
    }).join("");

    return `
      <div style="margin-bottom:20px;">
        <strong style="color:${groupColor};">${group}（${data.players.length}人）</strong>
        <ul>${members}</ul>
      </div>
    `;
  }).join("");
});

socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  document.body.innerHTML = `
    <h2>あなたは <strong>${newGroupId}</strong> に割り振られました</h2>
    <p>ホストが開始するまでお待ちください。</p>
  `;
});

socket.on("lock", () => {
  locked = true;
});

socket.on("end", (ranking) => {
  const game = document.getElementById("game");

  game.innerHTML = `
    <div style="display:flex;">
      <div style="flex:1;">
        <h2>🎉 ゲーム終了！</h2>
        <ol style="font-size: 1.5em;">
          ${ranking.map(p =>
            `<li>${p.name}（スコア: ${p.finalScore}｜累計: ${p.totalScore ?? 0}｜正解数: ${p.correctCount ?? 0}）</li>`
          ).join("")}
        </ol>
        ${
          isHost
            ? `<button id="nextGameBtn" style="margin-top:20px;font-size:1.2em;padding:10px 20px;">次のゲームへ</button>`
            : `<p style="color:gray;">※ホストが次のゲームを開始します</p>`
        }
      </div>
      <div id="globalRanking" style="flex:1; padding-left:20px;"></div>
    </div>
  `;

  if (isHost) {
    document.getElementById("nextGameBtn").onclick = () => {
      socket.emit("host_start");
    };
  }

  // 全体ランキングのリクエスト
  socket.emit("request_global_ranking");
});



socket.on("timer_start", ({ seconds }) => {
  if (countdownIntervalId) {
    clearInterval(countdownIntervalId);
    countdownIntervalId = null;
  }

  let countdown = seconds;
  const timer = document.getElementById("countdown-timer");
  if (!timer) return;

  timer.textContent = `⏳ ${countdown}s`;

  countdownIntervalId = setInterval(() => {
    countdown--;
    if (countdown >= 0) {
      timer.textContent = `⏳ ${countdown}s`;
    }
    if (countdown <= 0) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
      timer.textContent = "";
    }
  }, 1000);
});




function updateUI(state) {
  console.log("🎯 updateUI called", state); // ← 追加
  const game = document.getElementById("game");
  game.innerHTML = `
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
<div style="font-size: 1.5em;">HP: ${myHP}｜正解数: ${getMyCorrectCount(state)}</div>
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
        <div style="font-size: 1.5em;">HP: ${p.hp}｜正解数: ${p.correctCount ?? 0}</div>
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

function getMyCorrectCount(state) {
  return state.players.find(p => p.name === playerName)?.correctCount ?? 0;
}

function submitAnswer(number) {
  if (locked || alreadyAnswered) {
    console.log("回答ブロック中");
    return;
  }
  console.log("✅ 回答送信", number);
  socket.emit("answer", { groupId, name: playerName, number });
  alreadyAnswered = true;
}

function submitGrouping() {
  const groupCount = parseInt(document.getElementById("groupCount").value);
  const playersPerGroup = parseInt(document.getElementById("playersPerGroup").value);
  const topGroupCount = parseInt(document.getElementById("topGroupCount").value);

  socket.emit("host_assign_groups", {
    groupCount,
    playersPerGroup,
    topGroupCount
  });
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
      hasAnimated = true;  // ✅←ここで設定
    }
  }, speed);



}
