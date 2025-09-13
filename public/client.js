// client.js (UIフロー最終版 - 全文・省略なし)

// --- グローバル変数 ---
let socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
});
let playerId = localStorage.getItem('playerId');
let playerName = localStorage.getItem('playerName') || "";
let isHost = false; 
let gameMode = ''; 
let groupId = "";
let rankingIntervalId = null, readInterval = null, unmaskIntervalId = null, countdownIntervalId = null, singleGameTimerId = null;
let lastQuestionText = "", hasAnimated = false, alreadyAnswered = false;

// --- UIヘルパー ---
const getContainer = () => document.getElementById('app-container');
const getNavBar = () => document.getElementById('nav-bar');
function clearAllTimers() {
    if (rankingIntervalId) clearInterval(rankingIntervalId);
    if (readInterval) clearInterval(readInterval);
    if (unmaskIntervalId) clearInterval(unmaskIntervalId);
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    if (singleGameTimerId) clearInterval(singleGameTimerId);
    rankingIntervalId = null; readInterval = null; unmaskIntervalId = null; countdownIntervalId = null; singleGameTimerId = null;
    const countdownTimer = document.getElementById('countdown-timer');
    if (countdownTimer) countdownTimer.textContent = '';
    console.log('All client timers cleared.');
}
function updateNavBar(backAction, showTop = true) {
    const navBar = getNavBar(), backBtn = document.getElementById('nav-back-btn'), topBtn = document.getElementById('nav-top-btn');
    backBtn.style.display = backAction ? 'block' : 'none';
    if (backAction) backBtn.onclick = backAction;
    topBtn.style.display = showTop ? 'block' : 'none';
    if (showTop) topBtn.onclick = showModeSelectionUI;
    navBar.style.display = (backAction || showTop) ? 'flex' : 'none';
}

// --- 初期化 ---
socket.on('connect', () => {
  console.log('サーバーとの接続が確立しました。');
  if (!playerId) socket.emit('request_new_player_id');
  else {
    socket.emit('reconnect_player', { playerId, name: playerName });
    showModeSelectionUI();
  }
});
socket.on('disconnect', () => { 
    clearAllTimers();
    getContainer().innerHTML = `<div style="text-align:center;"><h2>接続が切れました</h2><p>再接続中...</p></div>`; 
});
socket.on('new_player_id_assigned', (newPlayerId) => {
  playerId = newPlayerId;
  localStorage.setItem('playerId', newPlayerId);
  showModeSelectionUI();
});

// ================================================================
// ★★★ UIフロー関数群 ★★★
// ================================================================

// 1. トップ画面：モード選択
function showModeSelectionUI() {
    clearAllTimers();
    updateNavBar(null, false);
    gameMode = ''; isHost = false; localStorage.removeItem('isHost');
    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>理科カルタ</h1><h2>どのモードで遊びますか？</h2>
            <div style="margin: 20px 0; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;">みんなでプレイ (個人戦)</button>
                <button id="team-play-btn" class="button" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px; background-color: #38a169; color: white;">みんなでプレイ (団体戦)</button>
                <button id="solo-play-btn" class="button-secondary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;">ひとりでプレイ</button>
            </div>
            <hr><button id="upload-btn" class="button-outline">問題セットの管理</button>
        </div>`;
    document.getElementById('multi-play-btn').onclick = () => { gameMode = 'multi'; showRoleSelectionUI(); };
    document.getElementById('team-play-btn').onclick = () => { gameMode = 'team'; showRoleSelectionUI(); };
    document.getElementById('solo-play-btn').onclick = () => {
        gameMode = 'solo'; isHost = false;
        getContainer().innerHTML = `<p>問題リストを読み込んでいます...</p>`;
        socket.emit('request_presets');
    };
    document.getElementById('upload-btn').onclick = () => {
        gameMode = 'admin'; isHost = true; localStorage.setItem('isHost', 'true');
        socket.emit('host_join', { playerId });
        socket.emit('request_game_phase');
    };
}

// 2. 役割選択 (ホスト/プレイヤー)
function showRoleSelectionUI() {
    clearAllTimers();
    updateNavBar(showModeSelectionUI);
    const modeText = gameMode === 'multi' ? '個人戦' : '団体戦';
    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>${modeText}</h1><h2>参加方法を選択してください</h2>
            <div style="margin: 20px 0; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                <button id="player-btn" class="button-primary" style="font-size: 1.8em; padding: 20px 40px; width: 80%; max-width: 400px;">プレイヤーで参加</button>
                <button id="host-btn" class="button-outline" style="font-size: 0.9em; margin-top: 20px;">ホストで参加</button>
            </div>
        </div>`;
    document.getElementById('player-btn').onclick = () => {
        isHost = false; localStorage.removeItem('isHost');
        socket.emit('request_game_phase');
    };
    document.getElementById('host-btn').onclick = () => {
        isHost = true; localStorage.setItem('isHost', 'true');
        socket.emit('host_join', { playerId });
        socket.emit('request_game_phase');
    };
}

// 3. 各モードのセットアップ画面振り分け
function showPlayerSetupUI(phase) {
    if (gameMode === 'multi' || gameMode === 'team') {
        const canJoin = phase === 'GROUP_SELECTION' || phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS';
        if (canJoin) {
            showGroupSelectionUI();
        } else {
            getContainer().innerHTML = `<p>現在ホストが準備中です。しばらくお待ちください。</p>`;
            updateNavBar(showRoleSelectionUI);
        }
    }
}
function showHostSetupUI(presets, fromEndScreen = false) {
    if (gameMode === 'multi' || gameMode === 'admin') {
        showCSVUploadUI(presets, fromEndScreen); 
    } else if (gameMode === 'team') {
        getContainer().innerHTML = '<h2>団体戦 ホスト設定画面</h2><p>(実装中...)</p>';
        updateNavBar(showRoleSelectionUI);
    }
}

// (ここから下は、元のコードとほぼ同じ)
function showCSVUploadUI(presets = {}, fromEndScreen = false) {
  clearAllTimers();
  updateNavBar(showRoleSelectionUI);
  const container = getContainer();
  const presetOptions = Object.entries(presets).map(([id, data]) => `<option value="${id}">${data.category} - ${data.name}</option>`).join('');
  container.innerHTML = `
    <h2>${fromEndScreen ? '次の問題を選択' : (gameMode === 'admin' ? '問題セットの管理' : '1. 設定と問題のアップロード')}</h2>
    <fieldset>
      <legend>問題ソース</legend>
      <div style="display: flex; align-items: center; gap: 10px;">
        <input type="radio" id="source-preset" name="source-type" value="preset" checked>
        <label for="source-preset" class="label-inline">保存済みリストから選ぶ</label>
        <select id="preset-select" style="flex-grow: 1;">${presetOptions}</select>
        <button id="delete-preset-btn" class="button" style="background-color: #e53e3e; color: white;">削除</button>
      </div>
      <div style="margin-top: 10px;">
        <input type="radio" id="source-csv" name="source-type" value="csv">
        <label for="source-csv" class="label-inline">新しいCSVファイルをアップロード</label>
      </div>
      <div id="csv-upload-area" style="display: none; margin-top: 10px; padding: 10px; border: 1px dashed #ccc; border-radius: 4px;">
        <input type="file" id="csvFile" accept=".csv" />
        <br><br>
        <div id="save-options">
            <input type="radio" id="save-action-new" name="save-action" value="new" checked><label for="save-action-new" class="label-inline">新規リストとして保存</label><br>
            <input type="radio" id="save-action-append" name="save-action" value="append"><label for="save-action-append" class="label-inline">既存のリストに追加</label><br>
            <input type="radio" id="save-action-overwrite" name="save-action" value="overwrite"><label for="save-action-overwrite" class="label-inline">既存のリストを上書き</label>
        </div>
        <div id="save-csv-details" style="margin-top: 10px;">
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
    <button id="submit-settings" class="button-primary">${fromEndScreen ? 'この問題で次のゲームを開始' : '決定してホスト画面へ'}</button>
    ${gameMode === 'admin' ? '' : `<hr style="border-color: #f6e05e; border-width: 2px; margin-top: 30px;" /><h3 style="color: #c05621;">データ管理</h3><p>アプリ更新前に「データを取り出し」、更新後に「データを読み込み」で問題やランキングを引き継げます。</p><button id="export-data-btn" class="button-outline">データを取り出し</button><label for="import-file-input" class="button button-outline">データを読み込み</label><input type="file" id="import-file-input" accept=".json" style="display: none;" />`}
  `;
  document.querySelectorAll('input[name="source-type"]').forEach(r => r.onchange = e => document.getElementById('csv-upload-area').style.display = e.target.value === 'csv' ? 'block' : 'none');
  document.querySelectorAll('input[name="save-action"]').forEach(r => r.onchange = e => {
      document.getElementById('csv-category-name').style.display = e.target.value === 'new' ? 'block' : 'none';
      document.getElementById('csv-list-name').style.display = e.target.value === 'new' ? 'block' : 'none';
  });
  document.getElementById('submit-settings').onclick = () => handleSettingsSubmit(fromEndScreen);
  if (gameMode !== 'admin') {
      document.getElementById('export-data-btn').onclick = () => socket.emit('host_export_data');
      document.getElementById('import-file-input').onchange = handleDataImport;
  }
  document.getElementById('delete-preset-btn').onclick = handleDeletePreset;
}

function showGroupSelectionUI() {
  clearAllTimers();
  updateNavBar(showRoleSelectionUI);
  const container = getContainer();
  const modeText = gameMode === 'multi' ? '個人戦' : '団体戦';
  container.innerHTML = `<h2>${modeText}：待機場所を選択</h2><p>ホストがゲームを開始するまで、好きな場所で待機してください。</p>`;
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = `待機場所 ${i}`; btn.style.margin = '5px';
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", { groupId, playerId });
      showNameInputUI();
    };
    container.appendChild(btn);
  }
}

function showNameInputUI() {
  clearAllTimers();
  updateNavBar(showGroupSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>プレイヤー名を入力</h2>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" />
    <button id="fix-name-btn" class="button-primary">決定</button>`;
  document.getElementById('fix-name-btn').onclick = fixName;
}

function showHostUI() {
  clearAllTimers();
  updateNavBar(showRoleSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>👑 個人戦 ホスト管理画面</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div id="hostStatus" style="flex:2; min-width: 300px;"></div>
      <div id="globalRanking" style="flex:1; min-width: 250px;"></div>
    </div><hr/>
    <h3>🔀 グループ割り振り設定</h3>
    <div>
      <label>グループ数：<input id="groupCount" type="number" value="3" min="1" max="10"></label>
      <label>上位何グループに集中：<input id="topGroupCount" type="number" value="1" min="1"></label>
    </div>
    <div id="group-size-inputs" style="margin-top: 10px;"></div>
    <button id="submit-grouping-btn" style="margin-top:10px;">グループ割り振りを実行</button><hr/>
    <button id="host-start-all-btn" class="button-primary" style="font-size:1.2em;">ゲーム開始</button>
    <button id="change-settings-btn" class="button-outline">問題・設定を変更</button><hr style="border-color:red; margin-top:30px;"/>
    <h3 style="color:red;">危険な操作</h3>
    <button id="host-reset-all-btn" style="background-color:crimson; color:white;">ゲームを完全リセット</button>`;
  const groupCountInput = document.getElementById('groupCount');
  const groupSizeContainer = document.getElementById('group-size-inputs');
  const updateGroupSizeInputs = () => {
      const count = parseInt(groupCountInput.value) || 0;
      groupSizeContainer.innerHTML = '';
      for (let i = 1; i <= count; i++) {
          groupSizeContainer.innerHTML += `<label style="margin-right:15px;">グループ${i}人数：<input type="number" class="group-size-input" value="4" min="1"></label>`;
      }
  };
  groupCountInput.oninput = updateGroupSizeInputs;
  updateGroupSizeInputs();
  document.getElementById('submit-grouping-btn').onclick = submitGrouping;
  document.getElementById('host-start-all-btn').onclick = () => socket.emit('host_start');
  document.getElementById('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
  document.getElementById('host-reset-all-btn').onclick = () => { if(confirm('本当にリセットしますか？')) socket.emit('host_full_reset'); };
  rankingIntervalId = setInterval(() => { socket.emit("host_request_state"); socket.emit("request_global_ranking"); }, 2000);
  socket.emit("host_request_state");
  socket.emit("request_global_ranking");
}

function showGameScreen(state) {
  clearAllTimers();
  updateNavBar(isHost ? showHostUI : showGroupSelectionUI);
  const container = getContainer();
  if (!document.getElementById('game-area')) {
    container.innerHTML = `<div id="game-area">
        <div id="round-result-display" style="text-align:center; min-height: 2em; margin-bottom: 10px; font-size: 1.5em; font-weight: bold; color: var(--primary-color);"></div>
        <div id="yomifuda"></div><div id="cards-grid"></div><hr>
        <div style="display: flex; flex-wrap: wrap; gap: 30px;"><div id="my-info"></div><div id="others-info"></div></div>
      </div>`;
  }
  updateGameUI(state);
}

function showEndScreen(ranking) {
  clearAllTimers();
  updateNavBar(isHost ? showHostUI : showModeSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex:2; min-width: 300px;">
        <h3>今回のランキング (獲得スコア)</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">${ranking.map(p => `<li>${p.name}（スコア: ${p.finalScore}）</li>`).join("")}</ol>
        ${isHost ? `<button id="change-settings-btn" class="button-primary">問題・設定を変更する</button>` : `<p>ホストが次のゲームを準備しています。</p>`}
      </div>
      <div id="globalRanking" style="flex:1; min-width: 250px;"></div>
    </div>
  `;
  if (isHost) {
    document.getElementById('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
  }
  rankingIntervalId = setInterval(() => socket.emit("request_global_ranking"), 2000);
  socket.emit("request_global_ranking");
}

function showWaitingScreen() {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    getContainer().innerHTML = `<h2>待機中...</h2><p>ホストが次のゲームを準備しています。</p>`;
}

function showSinglePlaySetupUI(presets) {
  clearAllTimers();
  updateNavBar(showModeSelectionUI);
  const container = getContainer();
  const presetOptionsHTML = presets && Object.keys(presets).length > 0
    ? Object.entries(presets).map(([id, data], i) => `<div><input type="radio" id="p-${id}" name="preset-radio" value="${id}" ${i === 0 ? 'checked' : ''}><label for="p-${id}">${data.category} - ${data.name}</label></div>`).join('')
    : '<p>利用可能な問題セットがありません。</p>';
  container.innerHTML = `
    <h2>ひとりでプレイ</h2><p>名前を入力して、難易度と問題を選んでください。</p>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" /><hr/>
    <h3>難易度</h3>
    <select id="difficulty-select"><option value="easy">かんたん</option><option value="hard">むずかしい</option></select>
    <h3>問題リスト</h3><div id="preset-list-container">${presetOptionsHTML}</div><hr/>
    <button id="single-start-btn" class="button-primary" ${!(presets && Object.keys(presets).length > 0) ? 'disabled' : ''}>ゲーム開始</button>`;
  document.getElementById('single-start-btn').onclick = startSinglePlay;
}

function showSinglePlayGameUI() {
  clearAllTimers();
  updateNavBar(showSinglePlaySetupUI);
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
  const timerDiv = document.getElementById('countdown-timer');
  let timeLeft = 60;
  timerDiv.textContent = `残り時間: 1:00`;
  singleGameTimerId = setInterval(() => {
    timeLeft--;
    if (timeLeft < 0) {
      clearInterval(singleGameTimerId);
      singleGameTimerId = null;
      socket.emit('single_game_timeup');
      return;
    }
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    timerDiv.textContent = `残り時間: ${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, 1000);
}

function showSinglePlayEndUI({ score, personalBest, globalRanking, presetName }) {
  clearAllTimers();
  updateNavBar(showSinglePlaySetupUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>タイムアップ！</h2>
    <h4>問題セット: ${presetName}</h4>
    <h3>今回のスコア: <span style="font-size: 1.5em; color: var(--primary-color);">${score}</span>点</h3>
    <p>自己ベスト: ${personalBest}点 ${score >= personalBest ? '🎉記録更新！' : ''}</p>
    <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px;">
      <div id="single-ranking" style="flex: 1; min-width: 300px;">
        <h3>全体ランキング トップ10</h3>
        <ol>${globalRanking.map((r, i) => `<li style="${r.isMe ? 'font-weight:bold; color:var(--primary-color);' : ''}">${i + 1}. ${r.name} - ${r.score}点</li>`).join('')}</ol>
      </div>
    </div>
    <hr/>
    <button id="retry-btn" class="button-primary">もう一度挑戦</button>
  `;
  document.getElementById('retry-btn').onclick = () => showSinglePlaySetupUI({});
}

function handleSettingsSubmit(isNextGame = false) { /* ... */ }
function handleDataImport(event) { /* ... */ }
function handleDeletePreset() { /* ... */ }
function fixName() {
  playerName = document.getElementById("nameInput").value.trim();
  if (!playerName) return alert("名前を入力してください");
  localStorage.setItem('playerName', playerName);
  socket.emit("set_name", { groupId, playerId, name: playerName });
  getContainer().innerHTML = `<p>${groupId}で待機中...</p>`;
}

function submitAnswer(id) {
  if (alreadyAnswered) return;
  alreadyAnswered = true;
  if (gameMode === 'solo') socket.emit("single_answer", { id });
  else socket.emit("answer", { groupId, playerId, name: playerName, id });
}

function submitGrouping() { /* ... */ }

function startSinglePlay() {
  playerName = document.getElementById("nameInput").value.trim();
  if (!playerName) return alert("名前を入力してください");
  localStorage.setItem('playerName', playerName);
  const presetId = document.querySelector('input[name="preset-radio"]:checked')?.value;
  if (!presetId) return alert('問題を選んでください');
  const difficulty = document.getElementById('difficulty-select').value;
  socket.emit('start_single_play', { name: playerName, playerId, difficulty, presetId });
  getContainer().innerHTML = `<p>ゲーム準備中...</p>`;
}

function updateGameUI(state) { /* ... */ }
function updateSinglePlayGameUI(state) { /* ... */ }
function renderHpBar(hp) { /* ... */ }
function animateNormalText(elementId, text, speed) { /* ... */ }
function animateMaskedText(elementId, text, maskedIndices) { /* ... */ }
function showPointPopup(point) { /* ... */ }

// --- Socket.IOイベントリスナー ---
socket.on('game_phase_response', ({ phase, presets, fromEndScreen }) => {
    if (isHost) {
        showCSVUploadUI(presets, fromEndScreen);
    } else {
        if (gameMode === 'solo') {
            showSinglePlaySetupUI(presets);
        } else {
            showPlayerSetupUI(phase);
        }
    }
});
socket.on('host_setup_done', () => { if (isHost) showHostUI(); });
socket.on('presets_list', (presets) => {
    if (gameMode === 'solo') {
        showSinglePlaySetupUI(presets);
    }
});
socket.on('wait_for_next_game', showWaitingScreen);
socket.on("state", (state) => {
  if (!state || gameMode === 'solo') return;
  const isGameScreenActive = document.getElementById('game-area');
  if (state.current && !isGameScreenActive) showGameScreen(state);
  else if (isGameScreenActive) updateGameUI(state);
});
socket.on('single_game_start', (initialState) => { if (gameMode === 'solo') { showSinglePlayGameUI(); updateSinglePlayGameUI(initialState); } });
socket.on('single_game_state', (state) => { if (gameMode === 'solo') updateSinglePlayGameUI(state) });
socket.on('single_game_end', (result) => { if (gameMode === 'solo') showSinglePlayEndUI(result) });
socket.on("end", (ranking) => { if (gameMode === 'multi') showEndScreen(ranking); });
socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  getContainer().innerHTML = `<h2>あなたは <strong>${newGroupId}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});
socket.on("rejoin_game", (state) => {
    if (gameMode !== 'multi' || !state) return;
    groupId = state.groupId;
    showGameScreen(state);
});
socket.on("host_state", (allGroups) => { /* ... */ });
socket.on("global_ranking", (ranking) => { /* ... */ });
socket.on("timer_start", ({ seconds }) => { /* ... */ });
socket.on('force_reload', (message) => { /* ... */ });
socket.on('export_data_response', (data) => { /* ... */ });
socket.on('import_data_response', ({ success, message }) => { /* ... */ });
