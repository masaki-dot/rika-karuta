// client.js (修正完了版)

// --- グローバル変数 ---
let socket = io();
let playerName = "";
let groupId = "";
let isHost = false;

// サーバーから受信した状態を保持
let lastQuestionText = "";
let hasAnimated = false;
let alreadyAnswered = false; // 二重回答防止フラグ
let readInterval = null; // 読み札アニメーション用のタイマーID
let countdownIntervalId = null; // 30秒タイマーID

// --- UI描画のヘルパー関数 ---
const getContainer = () => document.getElementById('app-container');

// --- アプリケーションの初期化 ---
window.onload = () => {
  socket.emit('request_game_phase');
};

// --- UI描画関数群 (画面遷移) ---

function showCSVUploadUI() {
  const container = getContainer();
  container.innerHTML = `
    <h2>1. 設定と問題のアップロード</h2>
    <p>ゲームで使う問題のCSVファイルをアップロードしてください。</p>
    <input type="file" id="csvFile" accept=".csv" /><br/><br/>
    <fieldset>
      <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label><br/>
      <label>読み上げ速度(ms/5文字): <input type="number" id="speed" value="1000" min="100" /></label><br/>
    </fieldset>
    <button id="submit-csv" class="button-primary">決定してグループ選択へ</button>
  `;
  document.getElementById('submit-csv').onclick = handleCSVUpload;
}

function showGroupSelectionUI() {
  const container = getContainer();
  container.innerHTML = '<h2>2. グループを選択</h2>';
  
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = `グループ ${i}`;
    btn.onclick = () => {
      isHost = false;
      groupId = "group" + i;
      socket.emit("join", groupId);
      showNameInputUI();
    };
    container.appendChild(btn);
  }

  container.appendChild(document.createElement("hr"));

  const hostBtn = document.createElement("button");
  hostBtn.textContent = "👑 ホストとして参加";
  hostBtn.className = "button-outline";
  hostBtn.onclick = () => {
    isHost = true;
    socket.emit("host_join");
    showHostUI();
  };
  container.appendChild(hostBtn);
}

function showNameInputUI() {
  const container = getContainer();
  container.innerHTML = `
    <h2>3. プレイヤー名を入力</h2>
    <input type="text" id="nameInput" placeholder="名前を入力..." />
    <button id="fix-name-btn" class="button-primary">決定</button>
    <button id="back-to-group-btn">グループ選択に戻る</button>
  `;
  document.getElementById('fix-name-btn').onclick = fixName;
  document.getElementById('back-to-group-btn').onclick = backToGroupSelection;
}

function showStartUI() {
  const container = getContainer();
  container.innerHTML = `
    <h2>${playerName}さん、ようこそ！</h2>
    <p>ホストがゲームを開始するまで、ルールを確認してお待ちください。</p>
    <div style="text-align:left; line-height:1.6; background: #f4f5f6; padding: 15px; border-radius: 4px;">
      <h4>🎮 ゲームのルール</h4>
      <p><strong>🩸 HPが0になると脱落！</strong> 回答を間違えると自分のHPが減ります。</p>
      <p><strong>✅ 正解すると得点ゲット！</strong> 他の全員のHPが減ります。</p>
      <p><strong>🏆 ボーナススコア！</strong> 1位通過で+200点、2位通過で+100点。</p>
    </div>
    ${isHost ? `<button id="host-start-btn" class="button-primary" style="margin-top: 20px;">このグループでゲーム開始</button>` : ''}
  `;
  if (isHost) {
    document.getElementById('host-start-btn').onclick = () => socket.emit('host_start');
  }
}

function showHostUI() {
  const container = getContainer();
  container.innerHTML = `
    <h2>👑 ホスト画面</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div id="hostStatus" style="flex:2; min-width: 300px;"></div>
      <div id="globalRanking" style="flex:1; min-width: 250px;"></div>
    </div>
    <hr/>
    <h3>🔀 グループ割り振り設定</h3>
    <label>グループ数：<input id="groupCount" type="number" value="5" min="2" max="10"></label>
    <label>各グループの人数：<input id="playersPerGroup" type="number" value="3" min="1"></label>
    <label>上位何グループにスコア上位を集中：<input id="topGroupCount" type="number" value="1" min="1"></label>
    <button id="submit-grouping-btn" style="margin-top:10px;">グループ割り振りを実行</button>
    <hr/>
    <button id="host-start-all-btn" class="button-primary" style="margin-top:10px;font-size:1.2em;">全グループでゲーム開始</button>
  `;
  
  document.getElementById('submit-grouping-btn').onclick = submitGrouping;
  document.getElementById('host-start-all-btn').onclick = () => socket.emit('host_start');

  socket.emit("host_request_state");
  socket.emit("request_global_ranking");
  setInterval(() => {
    socket.emit("host_request_state");
    socket.emit("request_global_ranking");
  }, 2000);
}

function showGameScreen(state) {
  const container = getContainer();
  // ゲーム画面の骨格がまだなければ生成する
  if (!document.getElementById('game-area')) {
    container.innerHTML = `
      <div id="game-area">
        <div id="yomifuda"></div>
        <div id="cards-grid"></div>
        <hr>
        <div style="display: flex; flex-wrap: wrap; gap: 30px;">
          <div id="my-info"></div>
          <div id="others-info"></div>
        </div>
      </div>
    `;
  }
  updateGameUI(state);
}

function showEndScreen(ranking) {
  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex:2; min-width: 300px;">
        <h3>今回の順位</h3>
        <ol style="font-size: 1.2em;">
          ${ranking.map(p =>
            `<li>${p.name}（スコア: ${p.finalScore}｜累計: ${p.totalScore ?? 0}）</li>`
          ).join("")}
        </ol>
        ${isHost ? `<button id="next-game-btn" class="button-primary">次のゲームへ</button>` : `<p>ホストが次のゲームを開始します。</p>`}
      </div>
      <div id="globalRanking" style="flex:1; min-width: 250px;"></div>
    </div>
  `;

  if (isHost) {
    document.getElementById('next-game-btn').onclick = () => socket.emit("host_start");
  }
  socket.emit("request_global_ranking");
}


// --- イベントハンドラとロジック ---

function handleCSVUpload() {
  const fileInput = document.getElementById("csvFile");
  if (!fileInput.files[0]) return alert("CSVファイルを選んでください");

  Papa.parse(fileInput.files[0], {
    header: false,
    skipEmptyLines: true,
    complete: (result) => {
      const cards = result.data.slice(1).map(r => ({
        number: String(r[0]).trim(),
        term: String(r[1]).trim(),
        text: String(r[2]).trim()
      })).filter(c => c.term && c.text);

      const settings = {
        numCards: parseInt(document.getElementById("numCards").value),
        showSpeed: parseInt(document.getElementById("speed").value)
      };

      socket.emit("set_cards_and_settings", { cards, settings });
    }
  });
}

function fixName() {
  const nameInput = document.getElementById("nameInput");
  playerName = nameInput.value.trim();
  if (!playerName) return alert("名前を入力してください");
  socket.emit("set_name", { groupId, name: playerName });
  showStartUI();
}

function backToGroupSelection() {
  if (groupId) {
    socket.emit("leave_group", { groupId });
    groupId = "";
  }
  showGroupSelectionUI();
}

function submitAnswer(number) {
  if (alreadyAnswered) return;
  alreadyAnswered = true; // 即座にロック
  socket.emit("answer", { groupId, name: playerName, number });
}

function submitGrouping() {
  socket.emit("host_assign_groups", {
    groupCount: parseInt(document.getElementById("groupCount").value),
    playersPerGroup: parseInt(document.getElementById("playersPerGroup").value),
    topGroupCount: parseInt(document.getElementById("topGroupCount").value)
  });
}

// --- UI更新関数 ---

function updateGameUI(state) {
  // 問題が新しくなったかチェック
  if (state.current?.text !== lastQuestionText) {
    hasAnimated = false;
    alreadyAnswered = false; // 回答権を復活
    lastQuestionText = state.current.text;
  }
  
  // 読み札のアニメーション
  const yomifudaDiv = document.getElementById('yomifuda');
  if (yomifudaDiv && !hasAnimated && state.current?.text) {
    animateText('yomifuda', state.current.text, state.showSpeed);
    hasAnimated = true;
  }

  // 取り札の描画
  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = ''; // 一旦クリア
  state.current?.cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "card";
    
    let chosenByHtml = '';
    if (card.correct) {
      div.style.background = "gold";
      chosenByHtml = `<div style="font-size:0.8em; color: black;">${card.chosenBy}</div>`;
    } else if (card.incorrect) {
      div.style.background = "crimson";
      div.style.color = "white";
      chosenByHtml = `<div style="font-size:0.8em;">${card.chosenBy}</div>`;
    } else if (card.correctAnswer) {
      div.style.background = "lightgreen";
      div.style.border = "2px solid green";
    }

        div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>
                     ${chosenByHtml}`;
    
    div.onclick = () => {
        // サーバーからのlocked状態と、クライアントの二重回答防止をチェック
        if (!state.locked && !alreadyAnswered) {
            submitAnswer(card.number);
        }
    };
    cardsGrid.appendChild(div);
  });
  
  // プレイヤー情報の描画
  const myPlayer = state.players.find(p => p.name === playerName);
  const otherPlayers = state.players.filter(p => p.name !== playerName);

  const myInfoDiv = document.getElementById('my-info');
  if(myPlayer) {
    myInfoDiv.innerHTML = `<h4>自分: ${myPlayer.name} (正解: ${myPlayer.correctCount ?? 0})</h4>${renderHpBar(myPlayer.hp)}`;
  }

  const othersInfoDiv = document.getElementById('others-info');
  othersInfoDiv.innerHTML = '<h4>他のプレイヤー</h4>';
  otherPlayers.forEach(p => {
    othersInfoDiv.innerHTML += `<div><strong>${p.name} (正解: ${p.correctCount ?? 0})</strong>${renderHpBar(p.hp)}</div>`;
  });
}

function renderHpBar(hp) {
    const hpPercent = Math.max(0, hp / 20 * 100);
    let hpColor = "mediumseagreen";
    if (hp <= 5) hpColor = "crimson";
    else if (hp <= 10) hpColor = "orange";
    return `
      <div style="font-size: 0.9em;">HP: ${hp} / 20</div>
      <div style="background: #ccc; width: 100%; height: 20px; border-radius: 10px; overflow: hidden;">
        <div style="background: ${hpColor}; width: ${hpPercent}%; height: 100%;"></div>
      </div>
    `;
}

function animateText(elementId, text, speed) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = "";
  let i = 0;

  if (readInterval) clearInterval(readInterval);
  readInterval = setInterval(() => {
    i += 5;
    if (i >= text.length) {
      element.textContent = text;
      clearInterval(readInterval);
      readInterval = null;
      socket.emit("read_done", groupId);
    } else {
      element.textContent = text.slice(0, i);
    }
  }, speed);
}

function showPointPopup(point) {
  const popup = document.getElementById('point-popup');
  if (!popup) return;
  popup.textContent = `${point}点!`;
  popup.classList.add('show');
  setTimeout(() => popup.classList.remove('show'), 1500);
}


// --- Socket.IO イベントリスナー ---
socket.on('game_phase_response', ({ phase }) => {
  if (phase === 'INITIAL') {
    // まだゲームが始まっていなければ、CSVアップロード画面を表示
    showCSVUploadUI();
  } else {
    // 既に設定が終わっていれば、グループ選択画面を直接表示
    showGroupSelectionUI();
  }
});
socket.on("start_group_selection", showGroupSelectionUI);

socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  socket.emit("join", groupId); // サーバーに再参加を通知
  getContainer().innerHTML = `<h2>あなたは <strong>${groupId}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});

// client.js の修正箇所

socket.on("state", (state) => {
  if (!state || !state.players) return; // 不正なstateは無視

  // 【ここからが重要な修正】
  // state.current（現在の問題）が存在し、かつゲーム画面がまだ表示されていない場合、
  // それは「ゲームがまさに始まった」ことを意味するので、ゲーム画面を初めて表示する。
  if (state.current && !document.getElementById('game-area')) {
    showGameScreen(state);
  }
  // すでにゲーム画面が表示されている場合は、UIのデータだけを更新する。
  else if (document.getElementById('game-area')) {
    updateGameUI(state);
  }
  // それ以外の場合（名前入力画面など）、何もしない。これにより画面が上書きされるのを防ぐ。
  // 【ここまでが重要な修正】


  // 得点ポップアップ表示のロジックは変更なし
  if (state.current?.pointValue) {
    document.getElementById('current-point').textContent = `この問題: ${state.current.pointValue}点`;
    if(state.answered) {
        showPointPopup(state.current.pointValue);
    }
  }
});

socket.on("end", (ranking) => {
  showEndScreen(ranking);
});

socket.on("host_state", (allGroups) => {
  const div = document.getElementById("hostStatus");
  if (!div) return;
  div.innerHTML = `<h3>各グループの状況</h3>` + Object.entries(allGroups).map(([gId, data]) => {
    if (data.players.length === 0) return '';
    const members = data.players.map(p => `<li>${p.name} (HP: ${p.hp}, 正解: ${p.correctCount})</li>`).join("");
    return `<div style="margin-bottom:15px;"><strong style="color:${data.locked ? 'red' : 'green'};">${gId} (${data.players.length}人)</strong><ul>${members}</ul></div>`;
  }).join("");
});

socket.on("global_ranking", (ranking) => {
  const div = document.getElementById("globalRanking");
  if (!div) return;
  div.innerHTML = `<h3>🌏 全体ランキング</h3><ol>${ranking.map(p => `<li>${p.name} (累計: ${p.totalScore}点)</li>`).join("")}</ol>`;
});

socket.on("timer_start", ({ seconds }) => {
  const timerDiv = document.getElementById('countdown-timer');
  if (!timerDiv) return;
  
  if (countdownIntervalId) clearInterval(countdownIntervalId);
  
  let countdown = seconds;
  timerDiv.textContent = `⏳ ${countdown}s`;
  
  countdownIntervalId = setInterval(() => {
    countdown--;
    if (countdown >= 0) {
      timerDiv.textContent = `⏳ ${countdown}s`;
    } else {
      clearInterval(countdownIntervalId);
      timerDiv.textContent = "";
    }
  }, 1000);
});
