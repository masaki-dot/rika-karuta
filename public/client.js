// client.js (改善・完全版)

// --- グローバル変数 ---
let socket = io();
let playerId = localStorage.getItem('playerId');
let playerName = localStorage.getItem('playerName') || "";
let groupId = "";
let isHost = false;
let gameMode = 'multi';

let rankingIntervalId = null;
let readInterval = null;
let unmaskIntervalId = null;
let countdownIntervalId = null;

let lastQuestionText = "";
let hasAnimated = false;
let alreadyAnswered = false;

// --- UI描画のヘルパー関数 ---
const getContainer = () => document.getElementById('app-container');

function clearAllTimers() {
    if (rankingIntervalId) clearInterval(rankingIntervalId);
    if (readInterval) clearInterval(readInterval);
    if (unmaskIntervalId) clearInterval(unmaskIntervalId);
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    rankingIntervalId = null;
    readInterval = null;
    unmaskIntervalId = null;
    countdownIntervalId = null;
    console.log('All client timers cleared.');
}

// --- アプリケーションの初期化 ---
socket.on('connect', () => {
  console.log('サーバーとの接続が確立しました。');
  if (!playerId) {
    socket.emit('request_new_player_id');
  } else {
    socket.emit('reconnect_player', { playerId, name: playerName });
    showModeSelectionUI();
  }
});

socket.on('new_player_id_assigned', (newPlayerId) => {
  playerId = newPlayerId;
  localStorage.setItem('playerId', playerId);
  console.log('新しいPlayerIDが割り当てられました:', playerId);
  showModeSelectionUI();
});

// --- UI描画関数群 ---

function showModeSelectionUI() {
  clearAllTimers();
  const container = getContainer();
  container.innerHTML = `
    <div style="text-align: center;">
      <h1>理科カルタ</h1>
      <h2>モードを選択してください</h2>
      <div style="margin-top: 20px; margin-bottom: 30px;">
        <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; padding: 10px 30px; margin: 10px;">みんなでプレイ</button>
        <button id="single-play-btn" style="font-size: 1.5em; padding: 10px 30px; margin: 10px;">ひとりでプレイ</button>
      </div>
    </div>
  `;
  document.getElementById('multi-play-btn').onclick = () => {
    gameMode = 'multi';
    socket.emit('request_game_phase');
  };
  document.getElementById('single-play-btn').onclick = showSinglePlaySetupUI;
}

function showCSVUploadUI(presets = {}) {
  clearAllTimers();
  gameMode = 'multi';
  const container = getContainer();
  const presetOptions = Object.entries(presets).map(([id, data]) => 
    `<option value="${id}">${data.category} - ${data.name}</option>`
  ).join('');

  container.innerHTML = `
    <h2>1. 設定と問題のアップロード</h2>
    <fieldset>
      <legend>問題ソース</legend>
      <input type="radio" id="source-preset" name="source-type" value="preset" checked>
      <label for="source-preset">保存済みリストから選ぶ</label>
      <select id="preset-select">${presetOptions}</select>
      <br>
      <input type="radio" id="source-csv" name="source-type" value="csv">
      <label for="source-csv">新しいCSVファイルをアップロード</label>
      <div id="csv-upload-area" style="display: none; margin-top: 10px; padding: 10px; border: 1px dashed #ccc; border-radius: 4px;">
        <input type="file" id="csvFile" accept=".csv" />
        <br><br>
        <input type="checkbox" id="save-csv-checkbox">
        <label for="save-csv-checkbox" class="label-inline">この問題をサーバーに保存する</label>
        <div id="save-csv-details" style="display: none; margin-top: 10px;">
          <input type="text" id="csv-category-name" placeholder="カテゴリ名 (例: 日本史)">
          <input type="text" id="csv-list-name" placeholder="リスト名 (例: 鎌倉時代)">
        </div>
      </div>
    </fieldset>
    <hr/>
    <fieldset>
      <legend>ゲーム設定</legend>
      <label>取り札の数: <input type="number" id="numCards" value="5" min="5" max="10" /></label><br/>
      <label>読み上げ速度(ms/5文字): <input type="number" id="speed" value="1000" min="100" /></label><br/>
    </fieldset>
    <hr/>
    <fieldset>
      <legend>デフォルトのゲームモード</legend>
      <input type="radio" id="mode-mask" name="game-mode" value="mask" checked>
      <label class="label-inline" for="mode-mask">応用モード（問題文が隠される）</label>
      <br>
      <input type="radio" id="mode-normal" name="game-mode" value="normal">
      <label class="label-inline" for="mode-normal">通常モード（最初から全文表示）</label>
    </fieldset>
    <br/>
    <button id="submit-settings" class="button-primary">決定してグループ選択へ</button>
  `;
  // UIの表示切り替えロジック
  document.querySelectorAll('input[name="source-type"]').forEach(radio => {
    radio.onchange = (e) => {
      document.getElementById('preset-select').style.display = e.target.value === 'preset' ? 'inline-block' : 'none';
      document.getElementById('csv-upload-area').style.display = e.target.value === 'csv' ? 'block' : 'none';
    };
  });
  document.getElementById('save-csv-checkbox').onchange = (e) => {
      document.getElementById('save-csv-details').style.display = e.target.checked ? 'block' : 'none';
  };
  document.getElementById('submit-settings').onclick = handleSettingsSubmit;
}

function showGroupSelectionUI() {
  clearAllTimers();
  const container = getContainer();
  container.innerHTML = '<h2>2. グループを選択</h2>';
  
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = `グループ ${i}`;
    btn.onclick = () => {
      isHost = false;
      groupId = "group" + i;
      socket.emit("join", { groupId, playerId });
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
    socket.emit("host_join", { playerId });
    showHostUI();
  };
  container.appendChild(hostBtn);
}

function showNameInputUI() {
  clearAllTimers();
  const container = getContainer();
  container.innerHTML = `
    <h2>3. プレイヤー名を入力</h2>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" />
    <button id="fix-name-btn" class="button-primary">決定</button>
    <button id="back-to-group-btn">グループ選択に戻る</button>
  `;
  document.getElementById('fix-name-btn').onclick = fixName;
  document.getElementById('back-to-group-btn').onclick = backToGroupSelection;
}

function showHostUI() {
  clearAllTimers();
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
    <hr style="border-color: red; border-width: 2px; margin-top: 30px;" />
    <h3 style="color: red;">危険な操作</h3>
    <p>全てのプレイヤーデータ（累計スコア含む）を削除し、アプリを初期状態に戻します。</p>
    <button id="host-reset-all-btn" style="background-color: crimson; color: white;">ゲームを完全リセット</button>
  `;
  
  document.getElementById('submit-grouping-btn').onclick = submitGrouping;
  document.getElementById('host-start-all-btn').onclick = () => socket.emit('host_start');
  document.getElementById('host-reset-all-btn').onclick = () => {
    if (confirm('本当に全てのゲームデータをリセットしますか？この操作は元に戻せません。')) {
      socket.emit('host_full_reset');
    }
  };

  rankingIntervalId = setInterval(() => {
    socket.emit("host_request_state");
    socket.emit("request_global_ranking");
  }, 2000);
  socket.emit("host_request_state");
  socket.emit("request_global_ranking");
}

function showGameScreen(state) {
  clearAllTimers();
  const container = getContainer();
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
  clearAllTimers();
  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <p>他のグループのゲームが終了するまで、ランキングは変動する可能性があります。</p>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex:2; min-width: 300px;">
        <h3>今回の順位</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">
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

  rankingIntervalId = setInterval(() => {
    socket.emit("request_global_ranking");
  }, 2000);
  socket.emit("request_global_ranking");
}

function showSinglePlaySetupUI() {
  clearAllTimers();
  gameMode = 'single';
  const container = getContainer();
  container.innerHTML = `
    <h2>ひとりでプレイ</h2>
    <p>名前を入力して、難易度と問題を選んでください。</p>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" />
    <hr/>
    <h3>難易度</h3>
    <select id="difficulty-select">
      <option value="easy">かんたん</option>
      <option value="normal" selected>ふつう</option>
      <option value="hard">むずかしい</option>
    </select>
    <h3>問題リスト</h3>
    <div id="preset-list-container">読み込み中...</div>
    <hr/>
    <button id="single-start-btn" class="button-primary">ゲーム開始</button>
    <button id="back-to-mode-btn">モード選択に戻る</button>
  `;
  document.getElementById('back-to-mode-btn').onclick = showModeSelectionUI;
  document.getElementById('single-start-btn').onclick = startSinglePlay;
  socket.emit('request_presets');
}

function showSinglePlayGameUI(state) {
  clearAllTimers();
  const container = getContainer();
  if (!document.getElementById('game-area')) {
    container.innerHTML = `
      <div id="game-area">
        <div id="yomifuda"></div>
        <div id="cards-grid"></div>
        <hr>
        <div id="single-player-info"></div>
      </div>
    `;
  }
  updateSinglePlayGameUI(state);
}

function showSinglePlayEndUI({ score, ranking }) {
  clearAllTimers();
  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <h3>今回のスコア: <span style="font-size: 1.5em; color: gold;">${score}</span>点</h3>
    <div id="single-ranking">
      <h3>ハイスコアランキング</h3>
      <ol>
        ${ranking.map((r, i) => `<li>${i + 1}. ${r.name} - ${r.score}点 (${r.difficulty})</li>`).join('')}
      </ol>
    </div>
    <hr/>
    <button id="retry-btn" class="button-primary">もう一度挑戦</button>
    <button id="back-to-mode-btn">モード選択に戻る</button>
  `;
  document.getElementById('retry-btn').onclick = showSinglePlaySetupUI;
  document.getElementById('back-to-mode-btn').onclick = showModeSelectionUI;
}

// --- イベントハンドラとロジック ---

function handleSettingsSubmit() {
  const sourceType = document.querySelector('input[name="source-type"]:checked').value;
  const settings = {
    numCards: parseInt(document.getElementById("numCards").value),
    showSpeed: parseInt(document.getElementById("speed").value),
    gameMode: document.querySelector('input[name="game-mode"]:checked').value
  };

  if (sourceType === 'preset') {
    const presetId = document.getElementById('preset-select').value;
    if (!presetId) return alert('問題リストを選んでください');
    socket.emit("set_preset_and_settings", { presetId, settings });
  } else {
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
        socket.emit("set_cards_and_settings", { cards, settings });
      }
    });
  }
}

function fixName() {
  const nameInput = document.getElementById("nameInput");
  playerName = nameInput.value.trim();
  if (!playerName) return alert("名前を入力してください");
  localStorage.setItem('playerName', playerName);
  socket.emit("set_name", { groupId, playerId, name: playerName });
  getContainer().innerHTML = `<p>${groupId}で待機中...</p>`;
}

function backToGroupSelection() {
  if (groupId) {
    socket.emit("leave_group", { groupId, playerId });
    groupId = "";
  }
  showGroupSelectionUI();
}

function submitAnswer(number) {
  if (alreadyAnswered) return;
  alreadyAnswered = true;
  if (gameMode === 'multi') {
    socket.emit("answer", { groupId, playerId, name: playerName, number });
  } else {
    socket.emit("single_answer", { number });
  }
}

function submitGrouping() {
  socket.emit("host_assign_groups", {
    groupCount: parseInt(document.getElementById("groupCount").value),
    playersPerGroup: parseInt(document.getElementById("playersPerGroup").value),
    topGroupCount: parseInt(document.getElementById("topGroupCount").value)
  });
}

function startSinglePlay() {
  const nameInput = document.getElementById("nameInput");
  playerName = nameInput.value.trim();
  if (!playerName) return alert("名前を入力してください");
  localStorage.setItem('playerName', playerName);

  const presetId = document.querySelector('input[name="preset-radio"]:checked')?.value;
  if (!presetId) return alert('問題を選んでください');

  const difficulty = document.getElementById('difficulty-select').value;

  socket.emit('start_single_play', { name: playerName, playerId, difficulty, presetId });
  getContainer().innerHTML = `<p>ゲーム準備中...</p>`;
}


// --- UI更新関数 ---

function updateGameUI(state) {
  if (state.current?.text !== lastQuestionText) {
    hasAnimated = false;
    alreadyAnswered = false;
    lastQuestionText = state.current.text;
  }
  
  const yomifudaDiv = document.getElementById('yomifuda');
  if (yomifudaDiv && !hasAnimated && state.current?.text) {
    if (state.gameMode === 'mask' && state.current.maskedIndices) {
      animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
    } else {
      animateNormalText('yomifuda', state.current.text, state.showSpeed);
    }
    hasAnimated = true;
  }

  const pointDiv = document.getElementById('current-point');
  if (pointDiv && state.current?.point) {
    pointDiv.textContent = `この問題: ${state.current.point}点`;
  }
  
  const correctCard = state.current?.cards.find(c => c.correct);
  if (state.answered && correctCard && correctCard.chosenBy === playerName) {
    const alreadyPopped = document.querySelector('#point-popup.show');
    if (!alreadyPopped) {
      showPointPopup(state.current.point);
    }
  }

  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = '';
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

    div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>${chosenByHtml}`;
    div.onclick = () => {
        if (!state.locked && !alreadyAnswered) submitAnswer(card.number);
    };
    cardsGrid.appendChild(div);
  });
  
  const myPlayer = state.players.find(p => p.playerId === playerId);
  const otherPlayers = state.players.filter(p => p.playerId !== playerId);

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

function updateSinglePlayGameUI(state) {
  if (state.current?.text !== lastQuestionText) {
    hasAnimated = false;
    alreadyAnswered = false;
    lastQuestionText = state.current.text;
  }

  const yomifudaDiv = document.getElementById('yomifuda');
  if (yomifudaDiv && !hasAnimated && state.current?.text) {
    animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
    hasAnimated = true;
  }

  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = '';
  state.current?.cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "card";
    
    if (card.correct) div.style.background = "gold";
    else if (card.incorrect) div.style.background = "crimson";
    else if (card.correctAnswer) div.style.background = "lightgreen";

    if (card.isCPU) {
       div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">CPUが選択</div>`;
    } else {
       div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>`;
    }
    
    div.onclick = () => { if (!alreadyAnswered) submitAnswer(card.number); };
    cardsGrid.appendChild(div);
  });

  document.getElementById('single-player-info').innerHTML = `
    <h4>スコア: ${state.score} | 問題: ${state.questionCount} / ${state.maxQuestions}</h4>
  `;
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

function animateNormalText(elementId, text, speed) {
  const element = document.getElementById(elementId);
  if (!element) return;
  if (readInterval) clearInterval(readInterval);
  element.textContent = "";
  let i = 0;

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

function animateMaskedText(elementId, text, maskedIndices) {
  const element = document.getElementById(elementId);
  if (!element) return;
  if (unmaskIntervalId) clearInterval(unmaskIntervalId);

  let textChars = text.split('');
  let remainingIndices = [...maskedIndices];
  
  for (const index of remainingIndices) {
    if (textChars[index] !== ' ' && textChars[index] !== '　') textChars[index] = '？';
  }
  element.textContent = textChars.join('');

  const revealSpeed = remainingIndices.length > 0 ? 20000 / remainingIndices.length : 200;

  unmaskIntervalId = setInterval(() => {
    if (remainingIndices.length === 0) {
      clearInterval(unmaskIntervalId);
      unmaskIntervalId = null;
      element.textContent = text;
      if (gameMode === 'multi') socket.emit("read_done", groupId);
      return;
    }

    const randomIndex = Math.floor(Math.random() * remainingIndices.length);
    const indexToReveal = remainingIndices.splice(randomIndex, 1)[0];
    
    textChars[indexToReveal] = text[indexToReveal];
    element.textContent = textChars.join('');
  }, revealSpeed);
}

function showPointPopup(point) {
  const popup = document.getElementById('point-popup');
  if (!popup) return;
  popup.textContent = `+${point}点!`;
  popup.className = 'show';
  setTimeout(() => popup.classList.remove('show'), 1500);
}


// --- Socket.IO イベントリスナー ---

socket.on('game_phase_response', ({ phase, presets }) => {
  if (phase === 'INITIAL') {
    showCSVUploadUI(presets);
  } else {
    showGroupSelectionUI();
  }
});

socket.on("start_group_selection", showGroupSelectionUI);

socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  socket.emit("join", { groupId, playerId });
  getContainer().innerHTML = `<h2>あなたは <strong>${groupId}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});

socket.on("state", (state) => {
  if (!state) return;
  const amIReady = playerName !== "";
  const isGameScreenActive = document.getElementById('game-area');

  if (state.current && !isGameScreenActive && amIReady) {
    showGameScreen(state);
  } else if (isGameScreenActive) {
    updateGameUI(state);
  } else if (!amIReady && groupId) {
    showNameInputUI();
  }
});

socket.on("end", (ranking) => showEndScreen(ranking));

socket.on("host_state", (allGroups) => {
  const div = document.getElementById("hostStatus");
  if (!div) return;

  div.innerHTML = `<h3>各グループの状況</h3>` + Object.entries(allGroups).map(([gId, data]) => {
    if (data.players.length === 0) return '';
    const members = data.players.map(p => `<li>${p.name} (HP: ${p.hp}, 正解: ${p.correctCount})</li>`).join("");
    const modeSelector = `
      <label>モード: 
        <select class="group-mode-selector" data-groupid="${gId}">
          <option value="normal" ${data.gameMode === 'normal' ? 'selected' : ''}>通常</option>
          <option value="mask" ${data.gameMode === 'mask' ? 'selected' : ''}>応用</option>
        </select>
      </label>
    `;
    return `<div style="margin-bottom:15px; padding: 10px; border: 1px solid #eee; border-radius: 4px;">
              <strong style="color:${data.locked ? 'red' : 'green'};">${gId} (${data.players.length}人)</strong>
              ${modeSelector}
              <ul>${members}</ul>
            </div>`;
  }).join("");

  document.querySelectorAll('.group-mode-selector').forEach(selector => {
    selector.onchange = (e) => {
      const groupId = e.target.dataset.groupid;
      const gameMode = e.target.value;
      socket.emit('host_set_group_mode', { groupId, gameMode });
    };
  });
});

socket.on("global_ranking", (ranking) => {
    const div = document.getElementById("globalRanking");
  if (!div) return;
  div.innerHTML = `<h3><span style="font-size: 1.5em;">🌏</span> 全体ランキング</h3>
                   <ol style="padding-left: 20px;">
                     ${ranking.map((p, i) => `
                       <li style="padding: 4px 0; border-bottom: 1px solid #eee;">
                         <strong style="display: inline-block; width: 2em;">${i + 1}.</strong>
                         ${p.name} <span style="float: right; font-weight: bold;">${p.totalScore}点</span>
                       </li>`).join("")}
                   </ol>`;
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
      countdownIntervalId = null;
      timerDiv.textContent = "";
    }
  }, 1000);
});

socket.on('force_reload', (message) => {
    alert(message);
    window.location.reload();
});

// --- シングルプレイ用リスナー ---
socket.on('presets_list', (presets) => {
  const container = document.getElementById('preset-list-container');
  if (!container) return;
  const radioButtons = Object.entries(presets).map(([id, data], index) => `
    <div>
      <input type="radio" id="preset-${id}" name="preset-radio" value="${id}" ${index === 0 ? 'checked' : ''}>
      <label for="preset-${id}">${data.category} - ${data.name}</label>
    </div>
  `).join('');
  container.innerHTML = radioButtons;
});

socket.on('single_game_state', (state) => showSinglePlayGameUI(state));
socket.on('single_game_end', (result) => showSinglePlayEndUI(result));
