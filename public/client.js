// client.js (ステップ2: ひとりでプレイ修正版v2 - 全文)

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

// (タイマー関連のグローバル変数は変更なし)
let rankingIntervalId = null, readInterval = null, unmaskIntervalId = null, countdownIntervalId = null, singleGameTimerId = null;
let lastQuestionText = "", hasAnimated = false, alreadyAnswered = false;

// --- UI描画のヘルパー関数 ---
const getContainer = () => document.getElementById('app-container');
const getNavBar = () => document.getElementById('nav-bar');
const getNavBackBtn = () => document.getElementById('nav-back-btn');
const getNavTopBtn = () => document.getElementById('nav-top-btn');

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
    const navBar = getNavBar();
    const backBtn = getNavBackBtn();
    const topBtn = getNavTopBtn();

    if (backAction) {
        backBtn.style.display = 'block';
        backBtn.onclick = backAction;
    } else {
        backBtn.style.display = 'none';
    }
    
    if (showTop) {
        topBtn.style.display = 'block';
        topBtn.onclick = showModeSelectionUI;
    } else {
        topBtn.style.display = 'none';
    }
    
    navBar.style.display = (backAction || showTop) ? 'flex' : 'none';
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

socket.on('disconnect', () => {
    console.error('サーバーとの接続が切れました。再接続を試みます...');
    clearAllTimers();
    const container = getContainer();
    if (container) { container.innerHTML = `<div style="text-align: center;"><h2>接続が切れました</h2><p>サーバーに再接続しています...</p></div>`; }
});

socket.on('new_player_id_assigned', (newPlayerId) => {
  playerId = newPlayerId;
  localStorage.setItem('playerId', newPlayerId);
  showModeSelectionUI();
});


// ★★★★★ UIフローの関数群 ★★★★★

// --- STEP 1: トップ画面 (ゲームモード選択) ---
function showModeSelectionUI() {
    clearAllTimers();
    updateNavBar(null, false);
    gameMode = ''; isHost = false; localStorage.removeItem('isHost');

    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>理科カルタ</h1>
            <h2>どのモードで遊びますか？</h2>
            <div style="margin-top: 20px; margin-bottom: 30px; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;">みんなでプレイ (個人戦)</button>
                <button id="team-play-btn" class="button" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px; background-color: #38a169; color: white;">みんなでプレイ (団体戦)</button>
                <button id="solo-play-btn" class="button-secondary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;">ひとりでプレイ</button>
            </div>
            <hr>
            <button id="upload-btn" class="button-outline">問題セットの管理</button>
        </div>
    `;

    document.getElementById('multi-play-btn').onclick = () => { gameMode = 'multi'; showRoleSelectionUI(); };
    document.getElementById('team-play-btn').onclick = () => { gameMode = 'team'; showRoleSelectionUI(); };
    document.getElementById('solo-play-btn').onclick = () => { gameMode = 'solo'; isHost = false; showSinglePlaySetupUI(); };
    document.getElementById('upload-btn').onclick = () => { isHost = true; gameMode = 'admin'; socket.emit('request_presets_for_upload'); };
}

// --- STEP 2: 役割選択 (ホスト/プレイヤー) ---
function showRoleSelectionUI() {
    clearAllTimers();
    updateNavBar(showModeSelectionUI);
    const container = getContainer();
    const modeText = gameMode === 'multi' ? '個人戦' : '団体戦';
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>${modeText}</h1>
            <h2>参加方法を選択してください</h2>
            <div style="margin-top: 20px; margin-bottom: 30px; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                <button id="player-btn" class="button-primary" style="font-size: 1.8em; padding: 20px 40px; width: 80%; max-width: 400px; height: auto;">プレイヤーで参加</button>
                <button id="host-btn" class="button-outline" style="font-size: 0.9em; margin-top: 20px;">ホストで参加</button>
            </div>
        </div>
    `;

    document.getElementById('player-btn').onclick = () => {
        isHost = false;
        localStorage.removeItem('isHost');
        showGroupSelectionUI();
    };
    document.getElementById('host-btn').onclick = () => {
        isHost = true;
        localStorage.setItem('isHost', 'true');
        socket.emit('host_join', { playerId });
        if (gameMode === 'multi') { showHostMultiSetupUI(); } 
        else if (gameMode === 'team') { showHostTeamSetupUI(); }
    };
}

// --- STEP 3: 各モードの画面 ---

function showHostMultiSetupUI() {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    getContainer().innerHTML = '<h2>個人戦 ホスト設定画面</h2><p>（実装中...）</p>';
}

function showHostTeamSetupUI() {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    getContainer().innerHTML = '<h2>団体戦 ホスト設定画面</h2><p>（実装中...）</p>';
}

// ★★★ 「ひとりでプレイ」設定画面を修正 ★★★
function showSinglePlaySetupUI() {
  clearAllTimers();
  updateNavBar(showModeSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>ひとりでプレイ（1分間タイムアタック）</h2>
    <p>名前を入力して、難易度と問題を選んでください。</p>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" />
    <hr/>
    <h3>難易度</h3>
    <select id="difficulty-select">
      <option value="easy">かんたん（問題文が全文表示）</option>
      <option value="hard">むずかしい（問題文が隠される）</option>
    </select>
    <h3>問題リスト</h3>
    <div id="preset-list-container">読み込み中...</div>
    <hr/>
    <button id="single-start-btn" class="button-primary">ゲーム開始</button>
  `;
  document.getElementById('single-start-btn').onclick = startSinglePlay;
  // ★変更: 専用のイベントを送信
  socket.emit('request_solo_presets'); 
}

// (ここから下の既存関数群は変更なし)
function showCSVUploadUI(presets = {}, fromEndScreen = false) { /* ... */ }
function showGroupSelectionUI() { /* ... */ }
function showNameInputUI() { /* ... */ }
function showHostUI() { /* ... */ }
function showGameScreen(state) { /* ... */ }
function showEndScreen(ranking) { /* ... */ }
function showWaitingScreen() { /* ... */ }
function showSinglePlayGameUI() { /* ... */ }
function showSinglePlayEndUI({ score, personalBest, globalRanking, presetName }) { /* ... */ }
function handleSettingsSubmit(isNextGame = false) { /* ... */ }
function handleDataImport(event) { /* ... */ }
function handleDeletePreset() { /* ... */ }
function fixName() { /* ... */ }
function submitAnswer(id) { /* ... */ }
function submitGrouping() { /* ... */ }
function startSinglePlay() { /* ... */ }
function updateGameUI(state) { /* ... */ }
function updateSinglePlayGameUI(state) { /* ... */ }
function renderHpBar(hp) { /* ... */ }
function animateNormalText(elementId, text, speed) { /* ... */ }
function animateMaskedText(elementId, text, maskedIndices) { /* ... */ }
function showPointPopup(point) { /* ... */ }

// ★★★★★ Socket.IO イベントリスナー ★★★★★

socket.on('presets_for_upload', (presets) => {
    if (gameMode === 'admin') { showCSVUploadUI(presets); }
});

// ★★★ 'presets_list' を 'solo_presets_list' に変更 ★★★
socket.on('solo_presets_list', (presets) => {
    const container = document.getElementById('preset-list-container');
    if (!container) return; // 画面を離れていた場合は何もしない
    container.innerHTML = Object.entries(presets).map(([id, data], index) => `
      <div>
        <input type="radio" id="preset-${id}" name="preset-radio" value="${id}" ${index === 0 ? 'checked' : ''}>
        <label for="preset-${id}">${data.category} - ${data.name}</label>
      </div>
    `).join('');
});

socket.on('single_game_start', (initialState) => { if (gameMode === 'solo') { showSinglePlayGameUI(); updateSinglePlayGameUI(initialState); } });
socket.on('single_game_state', (state) => { if (gameMode === 'solo') updateSinglePlayGameUI(state) });
socket.on('single_game_end', (result) => { if (gameMode === 'solo') showSinglePlayEndUI(result) });

// (以下、個人戦用のイベントリスナーは変更なし)
socket.on('game_phase_response', ({ phase, presets, fromEndScreen }) => { /* ... */ });
socket.on('host_reconnect_success', () => { /* ... */ });
socket.on('multiplayer_status_changed', (phase) => { /* ... */ });
socket.on('host_setup_done', () => { if (isHost) showHostUI(); });
socket.on('wait_for_next_game', showWaitingScreen);
socket.on("assigned_group", (newGroupId) => { /* ... */ });
socket.on("state", (state) => { /* ... */ });
socket.on("rejoin_game", (state) => { /* ... */ });
socket.on("end", (ranking) => { if (gameMode === 'multi') showEndScreen(ranking); });
socket.on("host_state", (allGroups) => { /* ... */ });
socket.on("global_ranking", (ranking) => { /* ... */ });
socket.on("timer_start", ({ seconds }) => { /* ... */ });
socket.on('force_reload', (message) => { /* ... */ });
socket.on('export_data_response', (data) => { /* ... */ });
socket.on('import_data_response', ({ success, message }) => { /* ... */ });
