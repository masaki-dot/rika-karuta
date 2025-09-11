// client.js (接続処理 最終修正版 - 全文)

// --- グローバル変数 ---
let socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
});

let playerId = localStorage.getItem('playerId');
let playerName = localStorage.getItem('playerName') || "";
let isHost = localStorage.getItem('isHost') === 'true'; 
let groupId = "";
let gameMode = 'multi';

let rankingIntervalId = null;
let readInterval = null;
let unmaskIntervalId = null;
let countdownIntervalId = null;
let singleGameTimerId = null;

let lastQuestionText = "";
let hasAnimated = false;
let alreadyAnswered = false;

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
    const bonusTimer = document.getElementById('bonus-timer');
    if (bonusTimer) bonusTimer.style.display = 'none';
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
        topBtn.onclick = () => {
            isHost = false;
            localStorage.removeItem('isHost');
            gameMode = 'multi';
            showRoleSelectionUI();
        };
    } else {
        topBtn.style.display = 'none';
    }
    
    navBar.style.display = (backAction || showTop) ? 'flex' : 'none';
}

function showConnectingScreen() {
    clearAllTimers();
    updateNavBar(null, false);
    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h2>サーバーと通信中...</h2>
            <p>ページをリロードせず、しばらくお待ちください。</p>
        </div>
    `;
}

// --- アプリケーションの初期化 ---
socket.on('connect', () => {
  console.log('サーバーとの接続が確立しました。');
  showConnectingScreen();

  if (!playerId) {
    console.log("新しいPlayerIDをリクエストします。");
    socket.emit('request_new_player_id');
  } else {
    console.log(`既存のPlayerID (${playerId}) で再接続します。isHost: ${isHost}`);
    socket.emit('reconnect_player', { playerId, name: playerName, isHostClient: isHost });
  }
});

socket.on('disconnect', () => {
    console.error('サーバーとの接続が切れました。再接続を試みます...');
    clearAllTimers();
    const container = getContainer();
    if (container) {
        container.innerHTML = `
            <div style="text-align: center;">
                <h2>接続が切れました</h2>
                <p>サーバーに再接続しています...</p>
            </div>
        `;
    }
});

socket.on('new_player_id_assigned', (newPlayerId) => {
  console.log("新しいPlayerIDが割り当てられました:", newPlayerId);
  playerId = newPlayerId;
  localStorage.setItem('playerId', newPlayerId);
  showRoleSelectionUI();
});

// --- UI描画関数群 ---
function showRoleSelectionUI() {
    clearAllTimers();
    updateNavBar(null, false);
    isHost = false;
    localStorage.removeItem('isHost');
    gameMode = 'multi';
    const container = getContainer();
    container.innerHTML = `
        <div style="text-align: center;">
            <h1>理科カルタ</h1>
            <h2>参加方法を選択してください</h2>
            <div style="margin-top: 20px; margin-bottom: 30px;">
                <button id="host-btn" class="button-primary" style="font-size: 1.5em; height: 60px; margin: 10px;">ホストで参加</button>
                <button id="player-btn" class="button-secondary" style="font-size: 1.5em; height: 60px; margin: 10px;">プレイヤーで参加</button>
            </div>
        </div>
    `;
    document.getElementById('host-btn').onclick = () => {
        isHost = true;
        localStorage.setItem('isHost', 'true'); 
        socket.emit('host_join', { playerId });
        showConnectingScreen();
    };
    document.getElementById('player-btn').onclick = () => {
        isHost = false;
        localStorage.removeItem('isHost');
        socket.emit('request_game_phase');
        showConnectingScreen();
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
    
    const multiPlayBtn = document.getElementById('multi-play-btn');
    if (multiPlayBtn) {
        if (phase === 'GROUP_SELECTION') {
            multiPlayBtn.onclick = showGroupSelectionUI;
        } else if (phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS') {
            multiPlayBtn.onclick = () => socket.emit("rejoin_game", { playerId });
        }
    }
    
    document.getElementById('single-play-btn').onclick = showSinglePlaySetupUI;
}

function showCSVUploadUI(presets = {}, fromEndScreen = false) {
  clearAllTimers();
  updateNavBar(showRoleSelectionUI);
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

function showHostUI() {
  clearAllTimers();
  updateNavBar(() => socket.emit('request_game_phase', { fromEndScreen: true }));
  const container = getContainer();
  container.innerHTML = `
    <h2>👑 ホスト管理画面</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div id="hostStatus" style="flex:2; min-width: 300px;"></div>
      <div id="globalRanking" style="flex:1; min-width: 250px;"></div>
    </div>
    <hr/>
    <h3>🔀 グループ割り振り設定 (今回のスコア順)</h3>
    <div>
      <label>グループ数：<input id="groupCount" type="number" value="3" min="1" max="10"></label>
      <label>上位何グループにスコア上位を集中：<input id="topGroupCount" type="number" value="1" min="1"></label>
    </div>
    <div id="group-size-inputs" style="margin-top: 10px;">
    </div>
    <button id="submit-grouping-btn" style="margin-top:10px;">グループ割り振りを実行</button>
    <hr/>
    <button id="host-start-all-btn" class="button-primary" style="margin-top:10px;font-size:1.2em;">全グループでゲーム開始</button>
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
  document.getElementById('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
  document.getElementById('host-reset-all-btn').onclick = () => {
    if (confirm('本当に進行中のゲームデータをリセットしますか？この操作は元に戻せません。')) {
      localStorage.removeItem('isHost');
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
  updateNavBar(isHost ? showHostUI : showGroupSelectionUI);
  const container = getContainer();
  if (!document.getElementById('game-area')) {
    container.innerHTML = `
      <div id="game-area">
        <div id="bonus-timer"></div>
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
  updateNavBar(isHost ? showHostUI : () => showPlayerMenuUI('WAITING_FOR_NEXT_GAME'));

  const container = getContainer();
  container.innerHTML = `
    <h2>🎉 ゲーム終了！</h2>
    <div style="display:flex; flex-wrap: wrap; gap: 20px;">
      <div style="flex:2; min-width: 300px;">
        <h3>今回のランキング</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">
          ${ranking.map(p => `<li>${p.name}（スコア: ${p.finalScore}）</li>`).join("")}
        </ol>
        ${isHost ? `<button id="change-settings-btn" class="button-primary">問題・設定を変更する</button>` : `<p>ホストが次のゲームを準備しています。</p>`}
      </div>
      <div id="globalRanking" style="flex:1; min-width: 250px;">
      </div>
    </div>
  `;

  if (isHost) {
    document.getElementById('change-settings-btn').onclick = () => {
      socket.emit('host_preparing_next_game');
    };
  }

  rankingIntervalId = setInterval(() => socket.emit("request_global_ranking"), 2000);
  socket.emit("request_global_ranking");
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
        <ol>
          ${globalRanking.map((r, i) => `<li style="${r.isMe ? 'font-weight:bold; color:var(--primary-color);' : ''}">${i + 1}. ${r.name} - ${r.score}点</li>`).join('')}
        </ol>
      </div>
    </div>
    <hr/>
    <button id="retry-btn" class="button-primary">もう一度挑戦</button>
  `;
  document.getElementById('retry-btn').onclick = showSinglePlaySetupUI;
}

function handleSettingsSubmit(isNextGame = false) {
  const submitBtn = document.getElementById('submit-settings');
  const sourceType = document.querySelector('input[name="source-type"]:checked').value;
  const settings = {
    numCards: parseInt(document.getElementById("numCards").value),
    showSpeed: parseInt(document.getElementById("speed").value),
    gameMode: document.querySelector('input[name="game-mode"]:checked').value
  };

  let payload = { settings, isNextGame };

  if (sourceType === 'preset') {
    const presetId = document.getElementById('preset-select').value;
    if (!presetId) return alert('問題リストを選んでください');
    payload.presetId = presetId;
    
    submitBtn.disabled = true;
    submitBtn.textContent = '処理中...';
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

    submitBtn.disabled = true;
    submitBtn.textContent = '処理中...';

    Papa.parse(fileInput.files[0], {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const rawData = result.data.slice(1).map(r => ({
          col1: String(r[0] || '').trim(),
          col2: String(r[1] || '').trim(),
          col3: String(r[2] || '').trim()
        })).filter(c => c.col1 && c.col2);
        
        if (rawData.length === 0) {
            alert('CSVファイルから有効な問題を読み込めませんでした。');
            submitBtn.disabled = false;
            submitBtn.textContent = isNextGame ? 'この問題で次のゲームを開始' : '決定してホスト画面へ';
            return;
        }
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
    if (!presetId || !presetId.startsWith('user_')) {
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
  socket.emit("set_name", { groupId, playerId, name: playerName });
  getContainer().innerHTML = `<p>${groupId}で待機中...</p>`;
}

function submitAnswer(id) {
  if (alreadyAnswered) return;
  alreadyAnswered = true;

  const cardsGrid = document.getElementById('cards-grid');
  if (cardsGrid) {
      Array.from(cardsGrid.children).forEach(cardEl => {
          if (cardEl.dataset.cardId === id) {
              cardEl.style.backgroundColor = '#e2e8f0';
              cardEl.style.transform = 'scale(0.95)';
          }
          cardEl.style.pointerEvents = 'none';
      });
  }

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
  
  const yomifudaDiv = document.getElementById('yomifuda');
  if (yomifudaDiv && !hasAnimated && state.current?.text) {
    if (state.gameMode === 'mask' && state.current.maskedIndices) {
      animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
    } else {
      animateNormalText('yomifuda', state.current.text, state.showSpeed);
    }
    hasAnimated = true;
  }
  
  const bonusTimerDiv = document.getElementById('bonus-timer');
  if (bonusTimerDiv) {
      if (state.gameSubPhase === 'bonusTime') {
          bonusTimerDiv.textContent = 'ボーナスタイム！ (5秒)';
          bonusTimerDiv.style.display = 'block';
      } else {
          bonusTimerDiv.style.display = 'none';
      }
  }

  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = '';
  state.current?.cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "card";
    div.dataset.cardId = card.id;
    
    let chosenByHtml = '';
    if (card.correct) {
      div.style.background = "gold";
      chosenByHtml = `<div class="chosen-by">${card.chosenBy}</div>`;
    } else if (card.incorrect) {
      div.style.background = "crimson";
      div.style.color = "white";
      chosenByHtml = `<div class="chosen-by">${card.chosenBy}</div>`;
    } else if (card.correctAnswer) {
      div.style.background = "lightgreen";
      div.style.border = "2px solid green";
    }

    div.innerHTML = `<div class="card-term">${card.term}</div>${chosenByHtml}`;
    
    if (state.answered || state.gameSubPhase === 'showingResult' || (state.gameSubPhase === 'bonusTime' && alreadyAnswered)) {
        div.style.pointerEvents = 'none';
        div.style.opacity = '0.7';
    } else {
        div.onclick = () => submitAnswer(card.id);
    }
    cardsGrid.appendChild(div);
  });
  
  const myPlayer = state.players.find(p => p.playerId === playerId);
  const otherPlayers = state.players.filter(p => p.playerId !== playerId);

  const myInfoDiv = document.getElementById('my-info');
  if(myPlayer && myInfoDiv) {
    myInfoDiv.innerHTML = `<h4>自分: ${myPlayer.name} (正解: ${myPlayer.correctCount ?? 0})</h4>${renderHpBar(myPlayer.hp)}`;
  }

  const othersInfoDiv = document.getElementById('others-info');
  if (othersInfoDiv) {
      othersInfoDiv.innerHTML = '<h4>他のプレイヤー</h4>';
      otherPlayers.forEach(p => {
        othersInfoDiv.innerHTML += `<div><strong>${p.name} (正解: ${p.correctCount ?? 0})</strong>${renderHpBar(p.hp)}</div>`;
      });
  }
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
  if (cardsGrid) {
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
  }
  const singlePlayerInfo = document.getElementById('single-player-info');
  if (singlePlayerInfo) {
      singlePlayerInfo.innerHTML = `<h4>スコア: ${state.score}</h4>`;
  }
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
      if (gameMode === 'multi') socket.emit("read_done", groupId);
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
socket.on('game_phase_response', ({ phase, presets, fromEndScreen }) => {
  if (isHost) {
      if (presets) {
          showCSVUploadUI(presets, fromEndScreen);
      } else {
          // presetsがない場合(host_joinからの応答)は再度リクエスト
          socket.emit('request_game_phase');
      }
  } else {
      showPlayerMenuUI(phase);
  }
});

socket.on('host_reconnect_success', () => {
    if (isHost) {
        console.log('ホストとして正常に復帰しました。管理画面を表示します。');
        showHostUI();
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
        const statusEl = document.getElementById('multi-play-status');
        if (statusEl) statusEl.textContent = statusText;
    }
});
socket.on('host_setup_done', () => { if (isHost) showHostUI(); });

socket.on('wait_for_next_game', showWaitingScreen);

socket.on("assigned_group", (newGroupId) => {
  groupId = newGroupId;
  getContainer().innerHTML = `<h2>あなたは <strong>${newGroupId}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});

socket.on("state", (state) => {
  if (gameMode !== 'multi') return;
  if (!state) return;

  if (state.current?.text !== lastQuestionText) {
    alreadyAnswered = false;
  }
  
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

socket.on("rejoin_game", (state) => {
    if (gameMode !== 'multi') return;
    if (!state) return;
    groupId = state.groupId;
    showGameScreen(state);
});

socket.on("end", (ranking) => {
  if (gameMode !== 'multi') return;
  showEndScreen(ranking);
});

socket.on("host_state", (allGroups) => {
  const div = document.getElementById("hostStatus");
  if (!div) return;
  div.innerHTML = `<h3>各グループの状況</h3>` + Object.entries(allGroups).map(([gId, data]) => {
    if (data.players.length === 0) return '';
    const members = data.players.map(p => 
        `<li>${p.name} (HP: ${p.hp}, 正解: ${p.correctCount})<br>
         <small>今回のスコア: ${p.currentScore} | 累計スコア: ${p.totalScore}</small></li>`
    ).join("");
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
  div.innerHTML = `<h3><span style="font-size: 1.5em;">🌏</span> 全体ランキング (累計)</h3>
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
    localStorage.removeItem('isHost');
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
