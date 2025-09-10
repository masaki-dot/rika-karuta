// client.js (ホスト認証修正・最終決定版)

// --- グローバル変数 ---
let socket = io();
let playerId = localStorage.getItem('playerId');
let playerName = localStorage.getItem('playerName') || "";
let hostKey = localStorage.getItem('hostKey');
let groupId = "";
let isHost = false;
let gameMode = 'multi';

let rankingIntervalId = null;
let readInterval = null;
let unmaskIntervalId = null;
let countdownIntervalId = null;
let singleGameTimerId = null;
let reconnectTimeout = null;

let lastQuestionText = "";
let hasAnimated = false;
let alreadyAnswered = false;

// --- UI描画のヘルパー関数 ---
const getContainer = () => document.getElementById('app-container');
const getNavBar = () => document.getElementById('nav-bar');
const getNavBackBtn = () => document.getElementById('nav-back-btn');
const getNavTopBtn = () => document.getElementById('nav-top-btn');

const isGameActive = () => document.getElementById('game-area') || document.getElementById('end-screen-ranking');

function clearAllTimers() {
    if (rankingIntervalId) clearInterval(rankingIntervalId);
    if (readInterval) clearInterval(readInterval);
    if (unmaskIntervalId) clearInterval(unmaskIntervalId);
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    if (singleGameTimerId) clearInterval(singleGameTimerId);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    rankingIntervalId = null; readInterval = null; unmaskIntervalId = null; countdownIntervalId = null; singleGameTimerId = null; reconnectTimeout = null;
    document.getElementById('countdown-timer').textContent = '';
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
        topBtn.onclick = showRoleSelectionUI;
    } else {
        topBtn.style.display = 'none';
    }
    
    navBar.style.display = (backAction || showTop) ? 'flex' : 'none';
}

// --- アプリケーションの初期化 ---
window.addEventListener('beforeunload', (event) => {
    if (isGameActive() && !isHost) { // ホストはリロードする可能性があるので対象外
        event.preventDefault();
        event.returnValue = '';
    }
});

socket.on('connect', () => {
  console.log('サーバーとの接続が確立しました。');
  const statusIndicator = document.getElementById('connection-status');
  statusIndicator.textContent = '● 接続中';
  statusIndicator.className = 'connected';
  
  getContainer().innerHTML = `<p>Loading...</p>`;
  reconnectTimeout = setTimeout(() => {
      console.warn("再接続後、サーバーから5秒間応答がありません。トップページに戻ります。");
      showRoleSelectionUI();
  }, 5000);

  if (!playerId) {
    socket.emit('request_new_player_id');
  } else {
    socket.emit('reconnect_player', { playerId, name: playerName });
  }
});

socket.on('disconnect', () => {
    console.warn('サーバーとの接続が切れました。');
    const statusIndicator = document.getElementById('connection-status');
    statusIndicator.textContent = '● 接続切れ';
    statusIndicator.className = 'disconnected';
});

socket.on('new_player_id_assigned', (newPlayerId) => {
  playerId = newPlayerId;
  localStorage.setItem('playerId', playerId);
  showRoleSelectionUI();
});

// --- UI描画関数群 ---

function showRoleSelectionUI() {
    clearAllTimers();
    updateNavBar(null, false);
    isHost = false;
    gameMode = 'multi';
    groupId = "";
    hostKey = localStorage.getItem('hostKey'); // 最新のホストキーを再取得
    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>理科カルタ</h1>
            <h2>参加方法を選択してください</h2>
            <div style="margin-top: 20px; margin-bottom: 30px;">
                <button id="host-btn" class="button-primary" style="font-size: 1.5em; height: 60px; margin: 10px;">ホストで参加</button>
                <button id="player-btn" class="button-secondary" style="font-size: 1.5em; height: 60px; margin: 10px;">プレイヤーで参加</button>
            </div>
            ${hostKey ? `<p style="color: var(--text-muted);">ホストとして復帰する場合は「ホストで参加」を押してください。<br>ホストキー: <strong>${hostKey}</strong></p>` : ''}
        </div>
    `;
    document.getElementById('host-btn').onclick = () => {
        isHost = true;
        hostKey = localStorage.getItem('hostKey'); // 送信する直前に最新の値を取得
        socket.emit('host_join', { playerId, hostKey });
    };
    document.getElementById('player-btn').onclick = () => {
        isHost = false;
        socket.emit('request_game_phase');
    };
}

function showPlayerMenuUI(phase) {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    const container = getContainer();
    const multiPlayEnabled = phase === 'GROUP_SELECTION' || phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS';
    const statusText = {
        'INITIAL': '現在、ホストがゲームを準備中です...',
        'GROUP_SELECTION': 'ホストの準備が完了しました！',
        'WAITING_FOR_NEXT_GAME': 'ホストが次の問題を選択中です...',
        'GAME_IN_PROGRESS': 'ゲームが進行中です。クリックして復帰します。'
    }[phase] || '待機中...';

    container.innerHTML = `
        <div style="text-align: center;">
            <h2>プレイヤーメニュー</h2>
            <div style="margin-top: 20px; margin-bottom: 30px;">
                <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; height: 60px; margin: 10px;" ${!multiPlayEnabled ? 'disabled' : ''}>みんなでプレイ</button>
                <button id="single-play-btn" class="button-secondary" style="font-size: 1.5em; height: 60px; margin: 10px;">ひとりでプレイ</button>
            </div>
            <p id="multi-play-status" style="color: var(--text-muted);">${statusText}</p>
        </div>
    `;
    
    if (phase === 'GROUP_SELECTION') {
        document.getElementById('multi-play-btn').onclick = showGroupSelectionUI;
    } else if (phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS') {
        document.getElementById('multi-play-btn').onclick = () => socket.emit("rejoin_game", { playerId });
    }
    
    document.getElementById('single-play-btn').onclick = showSinglePlaySetupUI;
}

function showCSVUploadUI(presets = {}, fromEndScreen = false) {
  clearAllTimers();
  updateNavBar(fromEndScreen ? () => socket.emit('host_join', { playerId, hostKey }) : showRoleSelectionUI);
  gameMode = 'multi';
  const container = getContainer();
  const presetOptions = Object.entries(presets).map(([id, data]) => 
    `<option value="${id}">${data.category} - ${data.name}</option>`
  ).join('');

  container.innerHTML = `
    <h2>${fromEndScreen ? '次の問題を選択' : '1. 設定と問題のアップロード'}</h2>
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
            <input type="radio" id="save-action-new" name="save-action" value="new" checked>
            <label for="save-action-new" class="label-inline">新規リストとして保存</label>
            <br>
            <input type="radio" id="save-action-append" name="save-action" value="append">
            <label for="save-action-append" class="label-inline">既存のリストに追加</label>
            <br>
            <input type="radio" id="save-action-overwrite" name="save-action" value="overwrite">
            <label for="save-action-overwrite" class="label-inline">既存のリストを上書き</label>
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
      <label>総合ランキング表示人数: <input type="number" id="ranking-display-count" value="10" min="1" /></label>
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
    <button id="submit-settings" class="button-primary">${fromEndScreen ? 'この問題で次のゲームを開始' : '決定してホスト画面へ'}</button>
    ${fromEndScreen ? '' : `<hr style="border-color: #f6e05e; border-width: 2px; margin-top: 30px;" />
    <h3 style="color: #c05621;">データ管理</h3>
    <p>アプリ更新前に「データを取り出し」、更新後に「データを読み込み」で問題やランキングを引き継げます。</p>
    <button id="export-data-btn" class="button-outline">データを取り出し</button>
    <label for="import-file-input" class="button button-outline" style="display: inline-block;">データを読み込み</label>
    <input type="file" id="import-file-input" accept=".json" style="display: none;" />`}
  `;
  document.querySelectorAll('input[name="source-type"]').forEach(radio => {
    radio.onchange = (e) => {
      document.getElementById('csv-upload-area').style.display = e.target.value === 'csv' ? 'block' : 'none';
    };
  });
  document.querySelectorAll('input[name="save-action"]').forEach(radio => {
    radio.onchange = (e) => {
        const isNew = e.target.value === 'new';
        document.getElementById('csv-category-name').style.display = isNew ? 'block' : 'none';
        document.getElementById('csv-list-name').style.display = isNew ? 'block' : 'none';
    };
  });
  document.getElementById('submit-settings').onclick = () => handleSettingsSubmit(fromEndScreen);
  if (!fromEndScreen) {
      document.getElementById('export-data-btn').onclick = () => socket.emit('host_export_data');
      document.getElementById('import-file-input').onchange = handleDataImport;
  }
  document.getElementById('delete-preset-btn').onclick = handleDeletePreset;
}

function showGroupSelectionUI() {
  clearAllTimers();
  updateNavBar(() => showPlayerMenuUI('GROUP_SELECTION'));
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
}

function showNameInputUI() {
  clearAllTimers();
  updateNavBar(showGroupSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <h2>3. プレイヤー名を入力</h2>
    <input type="text" id="nameInput" placeholder="名前を入力..." value="${playerName}" />
    <button id="fix-name-btn" class="button-primary">決定</button>
  `;
  document.getElementById('fix-name-btn').onclick = fixName;
}

function showHostUI(hostStateData = {}) {
  clearAllTimers();
  updateNavBar(null, false);
  const container = getContainer();
  const { lastGameRanking, isPaused } = hostStateData;
  
  const lastGameRankingHTML = lastGameRanking && lastGameRanking.length > 0 ? `
    <div id="this-game-ranking">
      <h3>今回のゲーム 全体順位</h3>
      <ol style="font-size: 0.9em; max-height: 200px; overflow-y: auto; padding-left: 20px;">
        ${lastGameRanking.map((p, i) => `<li>${i + 1}. ${p.name} - ${p.finalScore}点</li>`).join('')}
      </ol>
    </div>
    <hr/>
  ` : '';

  container.innerHTML = `
    <h2>👑 ホスト管理画面</h2>
    <p>ホストキー: <strong>${hostKey || '取得中...'}</strong> (このキーがあればブラウザを閉じても復帰できます)</p>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div id="hostStatus" style="flex:2; min-width: 300px;">
      </div>
      <div id="side-panel" style="flex:1; min-width: 250px;">
        <div id="unassigned-players"></div>
        ${lastGameRankingHTML}
        <div id="globalRankingWrapper">
            <div id="globalRanking"></div>
        </div>
      </div>
    </div>
    <hr/>
    <h3>🔀 グループ割り振り設定</h3>
    <div>
      <label>グループ数：<input id="groupCount" type="number" value="3" min="1" max="10"></label>
      <label>上位何グループにスコア上位を集中：<input id="topGroupCount" type="number" value="1" min="1"></label>
    </div>
    <div id="group-size-inputs" style="margin-top: 10px;">
    </div>
    <button id="submit-grouping-btn" style="margin-top:10px;">グループ割り振りを実行</button>
    <hr/>
    <button id="host-start-all-btn" class="button-primary" style="margin-top:10px;font-size:1.2em;">全グループでゲーム開始</button>
    <button id="pause-game-btn" class="button-outline" style="margin-top:10px;">${isPaused ? 'ゲームを再開' : 'ゲームを一時停止'}</button>
    <button id="change-settings-btn" class="button-outline" style="margin-top:10px;">問題・設定を変更する</button>
    <hr style="border-color: red; border-width: 2px; margin-top: 30px;" />
    <h3 style="color: red;">危険な操作</h3>
    <p>進行中のゲームデータ（プレイヤー情報、累計スコアなど）を削除し、アプリを初期状態に戻します。保存済みの問題やランキングは消えません。</p>
    <button id="host-reset-all-btn" style="background-color: crimson; color: white;">ゲームを完全リセット</button>
  `;
  
  const groupCountInput = document.getElementById('groupCount');
  const groupSizeContainer = document.getElementById('group-size-inputs');

  const updateGroupSizeInputs = () => {
      const count = parseInt(groupCountInput.value) || 0;
      groupSizeContainer.innerHTML = '';
      for (let i = 1; i <= count; i++) {
          groupSizeContainer.innerHTML += `
              <label style="margin-right: 15px;">グループ ${i} の人数：<input type="number" class="group-size-input" value="4" min="1"></label>
          `;
      }
  };

  groupCountInput.oninput = updateGroupSizeInputs;
  updateGroupSizeInputs();

  document.getElementById('submit-grouping-btn').onclick = submitGrouping;
  document.getElementById('host-start-all-btn').onclick = () => socket.emit('host_start');
  document.getElementById('pause-game-btn').onclick = () => socket.emit('host_toggle_pause');
  document.getElementById('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
  document.getElementById('host-reset-all-btn').onclick = () => {
    if (confirm('本当に進行中のゲームデータをリセットしますか？この操作は元に戻せません。')) {
      socket.emit('host_full_reset');
    }
  };

  rankingIntervalId = setInterval(() => {
    socket.emit("host_request_state");
  }, 2000);
  socket.emit("host_request_state");
}

function showGameScreen(state) {
  clearAllTimers();
  updateNavBar(isHost ? showHostUI : showGroupSelectionUI);
  const container = getContainer();
  container.innerHTML = `
    <div id="game-area">
      <h3 id="group-name-display"></h3>
      <div id="yomifuda"></div>
      <div id="cards-grid"></div>
      <hr>
      <div style="display: flex; flex-wrap: wrap; gap: 30px;">
        <div id="my-info"></div>
        <div id="others-info"></div>
      </div>
    </div>
  `;
  updateGameUI(state);
}

function showEndScreen(rankingData) {
  clearAllTimers();
  updateNavBar(isHost ? () => socket.emit('host_setup_done', { lastGameRanking: rankingData.thisGameOverall, isPaused: false }) : () => showPlayerMenuUI('WAITING_FOR_NEXT_GAME'));

  const { thisGame, cumulative, thisGameOverall } = rankingData;
  const myPlayerId = playerId;
  const myRank = cumulative.findIndex(p => p.playerId === myPlayerId) + 1;

  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex:2; min-width: 300px;">
        <h3>今回のゲーム順位（グループ内）</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">
          ${thisGame.map(p => {
            const overallRank = thisGameOverall.findIndex(op => op.playerId === p.playerId) + 1;
            return `<li>${p.name}（スコア: ${p.finalScore}点 <span style="font-size: 0.8em; color: var(--text-muted);">(全体 ${overallRank > 0 ? `${overallRank}位` : 'ランク外'})</span>）</li>`
          }).join("")}
        </ol>
        ${isHost ? `<button id="change-settings-btn" class="button-primary">問題・設定を変更する</button>` : `<p>ホストが次のゲームを準備しています。</p>`}
      </div>
      <div id="globalRanking" style="flex:1; min-width: 250px;">
        <h3>総合ランキング</h3>
        <ol>
          ${cumulative.map((p, i) => `<li style="${p.playerId === myPlayerId ? 'font-weight:bold; color:var(--primary-color);' : ''}">${i + 1}. ${p.name} - ${p.totalScore}点</li>`).join('')}
        </ol>
        ${myRank > 0 ? `<p style="margin-top: 10px; font-weight: bold; color: var(--primary-color);">あなたの総合順位: ${myRank}位</p>` : ''}
      </div>
    </div>
  `;

  if (isHost) {
    document.getElementById('change-settings-btn').onclick = () => {
      socket.emit('host_preparing_next_game');
    };
  }
}

function showWaitingScreen() {
    clearAllTimers();
    updateNavBar(showPlayerMenuUI);
    const container = getContainer();
    container.innerHTML = `
        <h2>待機中...</h2>
        <p>ホストが次の問題を選択しています。しばらくお待ちください。</p>
    `;
}

function showSinglePlaySetupUI() {
  clearAllTimers();
  gameMode = 'single';
  updateNavBar(showPlayerMenuUI);
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
  socket.emit('request_presets');
}

function showSinglePlayGameUI() {
  clearAllTimers();
  gameMode = 'single';
  updateNavBar(showSinglePlaySetupUI);
  const container = getContainer();
  container.innerHTML = `
    <div id="game-area">
      <div id="yomifuda"></div>
      <div id="cards-grid"></div>
      <hr>
      <div id="single-player-info"></div>
    </div>
  `;

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

function showSinglePlayEndUI({ score, personalBest, globalRanking, presetName, history }) {
  clearAllTimers();
  updateNavBar(showSinglePlaySetupUI);
  const container = getContainer();
  
  const historyHtml = history && history.length > 0 ? `
    <div style="flex: 1; min-width: 300px;">
        <h3>今回の結果詳細</h3>
        <ul style="max-height: 200px; overflow-y: auto; padding-left: 20px;">
            ${history.map(item => `
                <li style="color: ${item.correct ? 'green' : 'red'};">
                    <strong>${item.correct ? '正解' : '不正解'}</strong>: ${item.questionText} (答え: ${item.answer})
                </li>
            `).join('')}
        </ul>
    </div>
  ` : '';

  container.innerHTML = `
    <h2>タイムアップ！</h2>
    <h4>問題セット: ${presetName}</h4>
    <h3>今回のスコア: <span style="font-size: 1.5em; color: var(--primary-color);">${score}</span>点</h3>
    <p>自己ベスト: ${personalBest}点 ${score >= personalBest ? '🎉記録更新！' : ''}</p>
    <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px;">
      <div id="single-ranking" style="flex: 1; min-width: 300px;">
        <h3>全体ランキング トップ10</h3>
        <ol>
          ${globalRanking.map((r, i) => `<li style="${r.isMe ? 'font-weight:bold; color:var(--primary-color);' : ''}">${i + 1}. ${r.name} - ${r.score}点</li>`).join('')}
        </ol>
      </div>
      ${historyHtml}
    </div>
    <hr/>
    <button id="retry-btn" class="button-primary">もう一度挑戦</button>
  `;
  document.getElementById('retry-btn').onclick = showSinglePlaySetupUI;
}

// --- イベントハンドラとロジック ---

function handleSettingsSubmit(isNextGame = false) {
  const sourceType = document.querySelector('input[name="source-type"]:checked').value;
  const settings = {
    numCards: parseInt(document.getElementById("numCards").value),
    showSpeed: parseInt(document.getElementById("speed").value),
    gameMode: document.querySelector('input[name="game-mode"]:checked').value,
    rankingDisplayCount: parseInt(document.getElementById('ranking-display-count').value)
  };

  let payload = { settings, isNextGame };

  if (sourceType === 'preset') {
    const presetId = document.getElementById('preset-select').value;
    if (!presetId) return alert('問題リストを選んでください');
    payload.presetId = presetId;
    socket.emit("set_preset_and_settings", payload);
  } else {
    const fileInput = document.getElementById("csvFile");
    if (!fileInput.files[0]) return alert("CSVファイルを選んでください");

    const saveAction = document.querySelector('input[name="save-action"]:checked').value;
    payload.saveAction = saveAction;
    
    if (saveAction === 'new') {
        const category = document.getElementById('csv-category-name').value.trim();
        const name = document.getElementById('csv-list-name').value.trim();
        if (!category || !name) {
            return alert('新規保存の場合は、カテゴリ名とリスト名を入力してください。');
        }
        payload.presetInfo = { category, name };
    } else {
        const presetId = document.getElementById('preset-select').value;
        if (!presetId || !presetId.startsWith('user_')) {
            return alert('追加・上書きするには、保存済みのリスト（デフォルト以外）を選択してください。');
        }
        payload.presetId = presetId;
    }

    Papa.parse(fileInput.files[0], {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const rawData = result.data.slice(1).map(r => ({
          col1: String(r[0] || '').trim(),
          col2: String(r[1] || '').trim(),
          col3: String(r[2] || '').trim()
        })).filter(c => c.col1 && c.col2);
        
        if (rawData.length === 0) return alert('CSVファイルから有効な問題を読み込めませんでした。');
        payload.rawData = rawData;
        socket.emit("set_cards_and_settings", payload);
      }
    });
  }
}

function handleDataImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            if (confirm('現在のサーバーデータを上書きします。よろしいですか？')) {
                socket.emit('host_import_data', data);
            }
        } catch (error) {
            alert('ファイルの読み込みに失敗しました。有効なJSONファイルではありません。');
        }
    };
    reader.readAsText(file);
    event.target.value = '';
}

function handleDeletePreset() {
    const presetSelect = document.getElementById('preset-select');
    const presetId = presetSelect.value;
    if (!presetId) {
        return alert('削除するリストを選択してください。');
    }
    if (!presetId.startsWith('user_')) {
        return alert('デフォルトの問題リストは削除できません。');
    }

    const selectedOption = presetSelect.options[presetSelect.selectedIndex];
    const presetName = selectedOption.text;

    if (confirm(`本当に「${presetName}」を削除しますか？この操作は元に戻せません。`)) {
        socket.emit('host_delete_preset', { presetId });
    }
}

function fixName() {
  const nameInput = document.getElementById("nameInput");
  playerName = nameInput.value.trim();
  if (!playerName) return alert("名前を入力してください");
  localStorage.setItem('playerName', playerName);
  socket.emit("set_name", { playerId, name: playerName });
  getContainer().innerHTML = `<p>${groupId}で待機中...</p>`;
}

function backToGroupSelection() {
  if (groupId) {
    socket.emit("leave_group", { groupId, playerId });
    groupId = "";
  }
  showGroupSelectionUI();
}

function submitAnswer(id) {
  if (alreadyAnswered) return;
  alreadyAnswered = true;
  if (gameMode === 'multi') {
    socket.emit("answer", { groupId, playerId, name: playerName, id });
  } else {
    socket.emit("single_answer", { id });
  }
}

function submitGrouping() {
  const groupSizes = Array.from(document.querySelectorAll('.group-size-input')).map(input => parseInt(input.value) || 0);
  
  socket.emit("host_assign_groups", {
    groupCount: parseInt(document.getElementById("groupCount").value),
    topGroupCount: parseInt(document.getElementById("topGroupCount").value),
    groupSizes: groupSizes
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
  
  const groupNameDisplay = document.getElementById('group-name-display');
  if (groupNameDisplay) {
    groupNameDisplay.textContent = `あなたは ${state.groupId} です`;
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
        if (!state.locked && !alreadyAnswered) submitAnswer(card.id);
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
  hasAnimated = false;
  alreadyAnswered = false;

  const yomifudaDiv = document.getElementById('yomifuda');
  if (yomifudaDiv && !hasAnimated && state.current?.text) {
    if (state.difficulty === 'hard') {
      animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
    } else {
      yomifudaDiv.textContent = state.current.text;
    }
    hasAnimated = true;
  }

  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = '';
  state.current?.cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "card";
    
    if (card.correct) div.style.background = "gold";
    if (card.incorrect) div.style.background = "crimson";

    div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>`;
    div.onclick = () => { if (!alreadyAnswered) submitAnswer(card.id); };
    cardsGrid.appendChild(div);
  });

  document.getElementById('single-player-info').innerHTML = `
    <h4>スコア: ${state.score}</h4>
  `;
}

function renderHpBar(hp) {
    const hpPercent = Math.max(0, hp / 20 * 100);
    let hpColor;
    if (hp <= 5) hpColor = "#e53e3e";
    else if (hp <= 10) hpColor = "#dd6b20";
    else hpColor = "#48bb78";

    return `
      <div style="font-size: 0.9em; margin-bottom: 4px;">HP: ${hp} / 20</div>
      <div class="hp-bar-container">
        <div class="hp-bar-inner" style="width: ${hpPercent}%; background-color: ${hpColor};"></div>
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

socket.on('game_paused', (isPaused) => {
    if (!isHost) {
        const overlay = document.getElementById('pause-overlay');
        overlay.style.display = isPaused ? 'flex' : 'none';
    }
});

socket.on('host_key_assigned', (newHostKey) => {
    hostKey = newHostKey;
    localStorage.setItem('hostKey', hostKey);
    console.log(`ホストキーを受け取りました: ${hostKey}`);
});

socket.on('clear_host_key', () => {
    localStorage.removeItem('hostKey');
    hostKey = null;
    console.log('サーバーの指示によりホストキーを削除しました。');
});

socket.on('game_phase_response', ({ phase, presets, fromEndScreen }) => {
  if(reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = null;
  
  if (isHost) {
      showCSVUploadUI(presets, fromEndScreen);
  } else {
      showPlayerMenuUI(phase);
  }
});

socket.on('multiplayer_status_changed', (phase) => {
    const playerMenuButton = document.getElementById('multi-play-btn');
    if (playerMenuButton) {
        const multiPlayEnabled = phase === 'GROUP_SELECTION' || phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS';
        playerMenuButton.disabled = !multiPlayEnabled;
        const statusText = {
            'INITIAL': '現在、ホストがゲームを準備中です...',
            'GROUP_SELECTION': 'ホストの準備が完了しました！',
            'WAITING_FOR_NEXT_GAME': 'ホストが次の問題を選択中です...',
            'GAME_IN_PROGRESS': 'ゲームが進行中です。クリックして復帰します。'
        }[phase] || '待機中...';
        document.getElementById('multi-play-status').textContent = statusText;
    }
});

socket.on('host_setup_done', (hostStateData) => {
    if(reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
    if (isHost) showHostUI(hostStateData);
});

socket.on('show_host_ui_with_ranking', (ranking) => {
    if(isHost) showHostUI({ lastGameRanking: ranking });
});

socket.on('wait_for_next_game', showWaitingScreen);

socket.on("start_group_selection", showGroupSelectionUI);

socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  getContainer().innerHTML = `<h2>あなたは <strong>${groupId}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});

socket.on("state", (state) => {
  if (gameMode !== 'multi' || !state) return;
  
  if (state.current && !document.getElementById('game-area')) {
    showGameScreen(state);
  } else if (document.getElementById('game-area')) {
    updateGameUI(state);
  }
});

socket.on("rejoin_game", (state) => {
    if (gameMode !== 'multi' || !state) return;
    groupId = state.groupId;
    showGameScreen(state);
});

socket.on("end", (rankingData) => {
  if (gameMode !== 'multi') return;
  showEndScreen(rankingData);
});

socket.on("host_state", (hostState) => {
  if (!isHost) return;
  const { allGroups, unassignedPlayers, globalRanking, isPaused } = hostState;
  const hostStatusDiv = document.getElementById("hostStatus");
  if (!hostStatusDiv) return;

  hostStatusDiv.innerHTML = `<h3>各グループの状況</h3>` + Object.entries(allGroups).map(([gId, data]) => {
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
  
  const unassignedDiv = document.getElementById('unassigned-players');
  if (unassignedDiv) {
      if (unassignedPlayers && unassignedPlayers.length > 0) {
        unassignedDiv.innerHTML = `<h3>未所属プレイヤー (${unassignedPlayers.length}人)</h3>
                                   <ul style="font-size: 0.9em; max-height: 150px; overflow-y: auto;">
                                     ${unassignedPlayers.map(p => `<li>${p.name}</li>`).join('')}
                                   </ul><hr/>`;
      } else {
        unassignedDiv.innerHTML = '';
      }
  }

  const globalRankingDiv = document.getElementById("globalRanking");
  if (globalRankingDiv && globalRanking) {
      globalRankingDiv.innerHTML = `<h3><span style="font-size: 1.5em;">🌏</span> 総合ランキング</h3>
                   <ol style="padding-left: 20px;">
                     ${globalRanking.map((p, i) => `
                       <li style="padding: 4px 0; border-bottom: 1px solid #eee;">
                         <strong style="display: inline-block; width: 2em;">${i + 1}.</strong>
                         ${p.name} <span style="float: right; font-weight: bold;">${p.totalScore}点</span>
                       </li>`).join("")}
                   </ol>`;
  }
  
  const pauseButton = document.getElementById('pause-game-btn');
  if (pauseButton) {
      pauseButton.textContent = isPaused ? 'ゲームを再開' : 'ゲームを一時停止';
  }
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
    clearAllTimers();
    alert(message);
    window.location.reload();
});

socket.on('export_data_response', (data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rika_karuta_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert('データの取り出しが完了しました。');
});

socket.on('import_data_response', ({ success, message }) => {
    alert(message);
    if (success) {
        window.location.reload();
    }
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

socket.on('single_game_start', (initialState) => {
    showSinglePlayGameUI(); 
    updateSinglePlayGameUI(initialState);
});
socket.on('single_game_state', (state) => {
    updateSinglePlayGameUI(state)
});
socket.on('single_game_end', (result) => showSinglePlayEndUI(result));
