// client.js (学習完了後フロー改善版 - 全文)

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
let gameMode = 'multi'; // 'multi', 'single', 'learning'

let rankingIntervalId = null;
let readInterval = null;
let unmaskIntervalId = null;
let countdownIntervalId = null;
let singleGameTimerId = null;

let lastQuestionText = "";
let hasAnimated = false;
let alreadyAnswered = false;

let learningModeState = {};

// --- UI描画のヘルパー関数 ---
const getContainer = () => document.getElementById('app-container');
const getNavBar = () => document.getElementById('nav-bar');
const getNavBackBtn = () => document.getElementById('nav-back-btn');
const getNavTopBtn = () => document.getElementById('nav-top-btn');

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

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

// --- アプリケーションの初期化 ---
socket.on('connect', () => {
  console.log('サーバーとの接続が確立しました。');
  if (!playerId) {
    socket.emit('request_new_player_id');
  } else {
    socket.emit('reconnect_player', { playerId, name: playerName });
    if (isHost) {
        getContainer().innerHTML = '<p>ホストとして再接続しています...</p>';
    } else {
        const container = getContainer();
        if (!container.hasChildNodes() || container.querySelector('p')?.textContent === 'Loading...') {
            showRoleSelectionUI();
        }
    }
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
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 50vh; position: relative;">
            <div style="text-align: center; margin-bottom: 80px;">
                <h1>理科カルタ</h1>
                <p style="font-size: 1.2em;">下のボタンを押してゲームに参加しよう！</p>
            </div>
            
            <button id="player-btn" class="button-primary" style="font-size: 1.8em; padding: 20px 40px; width: 80%; max-width: 400px; height: auto;">プレイヤーで参加</button>
            
            <div style="position: absolute; bottom: -20px; right: 0;">
                <button id="host-btn" class="button-outline" style="font-size: 0.9em;">ホストはこちら</button>
            </div>
        </div>
    `;
    document.getElementById('host-btn').onclick = () => {
        isHost = true;
        localStorage.setItem('isHost', 'true'); 
        socket.emit('host_join', { playerId });
        socket.emit('request_game_phase');
    };
    document.getElementById('player-btn').onclick = () => {
        isHost = false;
        localStorage.removeItem('isHost');
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
            <div style="margin-top: 20px; margin-bottom: 30px; display: flex; flex-direction: column; align-items: center; gap: 15px;">
                <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;" ${!multiPlayEnabled ? 'disabled' : ''}>みんなでプレイ</button>
                <button id="single-play-btn" class="button-secondary" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px;">ひとりでプレイ</button>
                <button id="learning-mode-btn" class="button-outline" style="font-size: 1.5em; width: 80%; max-width: 400px; height: 60px; border-color: #48bb78; color: #48bb78;">学習モード(単語帳)</button>
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
    document.getElementById('learning-mode-btn').onclick = showLearningPresetSelectionUI;
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
      <label>デフォルトの取り札の数: <input type="number" id="numCards" value="5" min="3" max="20" /></label><br/>
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
        <div id="round-result-display" style="text-align:center; min-height: 2em; margin-bottom: 10px; font-size: 1.5em; font-weight: bold; color: var(--primary-color);"></div>
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
        <h3>今回のランキング (獲得スコア)</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">
          ${ranking.map(p => `<li>
              ${p.name}（スコア: ${p.finalScore}）
              ${p.bonus > 0 ? `<span style="color: #dd6b20; font-size: 0.8em; margin-left: 10px;">🏆生存ボーナス +${p.bonus}点！</span>` : ''}
            </li>`).join("")}
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

// ★★★ ここから学習モード専用のUIとロジック (完成版) ★★★

function showLearningPresetSelectionUI() {
    clearAllTimers();
    gameMode = 'learning';
    updateNavBar(showPlayerMenuUI);
    const container = getContainer();
    container.innerHTML = `
        <h2>学習モード (単語帳)</h2>
        <p>学習したい問題のリストを選んでください。</p>
        <div id="preset-list-container">読み込み中...</div>
        <div id="learning-options" style="display: none; margin-top: 20px;">
            <hr/>
            <h3>出題タイプ</h3>
            <input type="radio" id="mode-all" name="learning-type" value="all" checked>
            <label for="mode-all" class="label-inline">すべての問題から出題</label>
            <br>
            <input type="radio" id="mode-weak" name="learning-type" value="weak">
            <label for="mode-weak" class="label-inline">苦手な問題から出題 (直近3回で1度でも間違えた問題)</label>
            <br/><br/>
            <button id="learning-start-btn" class="button-primary">学習を開始</button>
        </div>
    `;
    socket.emit('request_presets');
}

function startLearningMode() {
    const presetId = document.querySelector('input[name="preset-radio"]:checked')?.value;
    if (!presetId) {
        return alert('問題を選んでください');
    }
    const learningType = document.querySelector('input[name="learning-type"]:checked').value;
    
    const startBtn = document.getElementById('learning-start-btn');
    startBtn.disabled = true;
    startBtn.textContent = '問題準備中...';

    socket.emit('get_full_preset_data', { presetId }, (presetData) => {
        if (!presetData) {
            alert('問題データの取得に失敗しました。');
            startBtn.disabled = false;
            startBtn.textContent = '学習を開始';
            return;
        }
        setupLearningSession(presetId, presetData, learningType);
    });
}

function setupLearningSession(presetId, presetData, learningType) {
    let allTorifudas = [];
    let allYomifudas = [];

    (presetData.rawData || presetData.cards).forEach(row => {
        if (presetData.rawData) {
            if (row.col1.startsWith('def_')) allTorifudas.push({ id: row.col1, term: row.col2 });
            else allYomifudas.push({ answer: row.col1, text: row.col3 });
        } else {
            allTorifudas.push({ id: `def_${row.number}`, term: row.term });
            allYomifudas.push({ answer: row.term, text: row.text });
        }
    });

    let questionPool = [...allYomifudas];

    if (learningType === 'weak') {
        const history = getLearningHistory(presetId);
        questionPool = allYomifudas.filter(yomifuda => {
            const questionHistory = history[yomifuda.text];
            if (!questionHistory) return true;
            if (questionHistory.answers.includes('incorrect')) return true;
            return false;
        });
    }

    if (questionPool.length === 0) {
        alert(learningType === 'weak' ? 'おめでとうございます！苦手な問題はありません。' : 'このセットには問題がありません。');
        showLearningPresetSelectionUI();
        return;
    }

    learningModeState = {
        presetId: presetId,
        allYomifudas: allYomifudas, // 全問題リストを保持
        questionPool: shuffle(questionPool),
        currentIndex: 0,
        allTorifudas: allTorifudas,
        answered: false,
        current: null
    };

    showNextLearningQuestion();
}

function showNextLearningQuestion() {
    if (learningModeState.currentIndex >= learningModeState.questionPool.length) {
        const container = getContainer();
        container.innerHTML = `
            <h2>学習完了！</h2>
            <p>セット内のすべての問題を学習しました。次は何をしますか？</p>
            <div style="display: flex; flex-direction: column; align-items: center; gap: 15px; margin-top: 20px;">
                <button id="restart-all-btn" class="button-primary" style="width: 80%; max-width: 400px;">もう一周 全問解く</button>
                <button id="restart-weak-btn" class="button" style="width: 80%; max-width: 400px;">もう一周 苦手な問題のみ解く</button>
                <button id="change-preset-btn" class="button-outline" style="width: 80%; max-width: 400px;">別の問題セットを解く</button>
                <button id="back-to-top-btn" class="button-outline" style="width: 80%; max-width: 400px;">トップメニューに戻る</button>
            </div>
        `;
        document.getElementById('restart-all-btn').onclick = () => restartLearningMode('all');
        document.getElementById('restart-weak-btn').onclick = () => restartLearningMode('weak');
        document.getElementById('change-preset-btn').onclick = showLearningPresetSelectionUI;
        document.getElementById('back-to-top-btn').onclick = showPlayerMenuUI;
        updateNavBar(showPlayerMenuUI);
        return;
    }

    const question = learningModeState.questionPool[learningModeState.currentIndex];
    const correctTorifuda = learningModeState.allTorifudas.find(t => t.term === question.answer);
    
    if (!correctTorifuda) {
        console.error('正解の取り札が見つかりませんでした。問題をスキップします:', question);
        learningModeState.currentIndex++;
        showNextLearningQuestion();
        return;
    }
    
    const distractors = shuffle([...learningModeState.allTorifudas.filter(t => t.id !== correctTorifuda.id)]).slice(0, 3);
    const cards = shuffle([...distractors, correctTorifuda]);

    learningModeState.current = {
        text: question.text,
        answer: question.answer,
        cards: cards.map(c => ({ id: c.id, term: c.term }))
    };
    learningModeState.answered = false;
    
    updateLearningModeUI();
}

// ★★★ 学習完了後にもう一度学習するためのヘルパー関数 ★★★
function restartLearningMode(learningType) {
    let questionPool = [...learningModeState.allYomifudas];

    if (learningType === 'weak') {
        const history = getLearningHistory(learningModeState.presetId);
        questionPool = learningModeState.allYomifudas.filter(yomifuda => {
            const questionHistory = history[yomifuda.text];
            if (!questionHistory) return true;
            if (questionHistory.answers.includes('incorrect')) return true;
            return false;
        });
    }

    if (questionPool.length === 0) {
        alert(learningType === 'weak' ? 'おめでとうございます！苦手な問題はありません。' : 'このセットには問題がありません。');
        return;
    }
    
    learningModeState.questionPool = shuffle(questionPool);
    learningModeState.currentIndex = 0;
    showNextLearningQuestion();
}

function updateLearningModeUI() {
    gameMode = 'learning';
    updateNavBar(showLearningPresetSelectionUI, false); // トップに戻るボタンを非表示
    const container = getContainer();
    const state = learningModeState;

    const history = getLearningHistory(state.presetId);
    const questionHistory = history[state.current.text] || { answers: [] };
    const correctCount = questionHistory.answers.filter(a => a === 'correct').length;
    const historyText = `学習履歴: 直近${questionHistory.answers.length}回中 ${correctCount}回正解`;

    container.innerHTML = `
      <div id="game-area">
        <p style="text-align: right; color: var(--text-muted);">
          問題 ${state.currentIndex + 1} / ${state.questionPool.length}
        </p>
        <div id="yomifuda">${state.current.text}</div>
        <p style="text-align: center; font-weight: bold; color: var(--primary-color);">${historyText}</p>
        <div id="cards-grid"></div>
        <div id="learning-controls" style="text-align: center; margin-top: 20px;"></div>
      </div>
    `;

    const cardsGrid = document.getElementById('cards-grid');
    cardsGrid.innerHTML = '';
    state.current.cards.forEach(card => {
        const div = document.createElement("div");
        div.className = "card";

        if (state.answered) {
            const isCorrectAnswerCard = state.allTorifudas.find(t => t.id === card.id)?.term === state.current.answer;
            if (isCorrectAnswerCard) {
                div.style.background = "gold";
            } else if (card.wasClicked) {
                div.style.background = "crimson";
                div.style.color = "white";
            }
        }
        
        div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>`;
        if (!state.answered) {
            div.onclick = () => handleLearningAnswer(card.id);
        } else {
            div.style.cursor = 'default';
        }
        cardsGrid.appendChild(div);
    });

    if (state.answered) {
        document.getElementById('learning-controls').innerHTML = `
            <button id="next-q-btn" class="button-primary">次の問題へ</button>
        `;
        document.getElementById('next-q-btn').onclick = showNextLearningQuestion;
        document.getElementById('next-q-btn').focus();
    }
}

function handleLearningAnswer(cardId) {
    if (learningModeState.answered) return;
    learningModeState.answered = true;

    const chosenCard = learningModeState.current.cards.find(c => c.id === cardId);
    if(chosenCard) chosenCard.wasClicked = true;

    const isCorrect = learningModeState.allTorifudas.find(t => t.id === cardId)?.term === learningModeState.current.answer;
    
    updateLearningHistory(learningModeState.presetId, learningModeState.current.text, isCorrect);
    
    learningModeState.currentIndex++;
    updateLearningModeUI();
}

function getLearningHistory(presetId) {
    try {
        const history = localStorage.getItem(`learningHistory_${presetId}`);
        return history ? JSON.parse(history) : {};
    } catch (e) {
        console.error("Failed to parse learning history:", e);
        return {};
    }
}

function updateLearningHistory(presetId, questionText, isCorrect) {
    const history = getLearningHistory(presetId);
    if (!history[questionText]) {
        history[questionText] = { answers: [] };
    }
    
    history[questionText].answers.push(isCorrect ? 'correct' : 'incorrect');
    if (history[questionText].answers.length > 3) {
        history[questionText].answers.shift();
    }

    try {
        localStorage.setItem(`learningHistory_${presetId}`, JSON.stringify(history));
    } catch (e) {
        console.error("Failed to save learning history:", e);
    }
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
        if (!category || !name) return alert('新規保存の場合は、カテゴリ名とリスト名を入力してください。');
        payload.presetInfo = { category, name };
    } else {
        const presetId = document.getElementById('preset-select').value;
        if (!presetId || !presetId.startsWith('user_')) return alert('追加・上書きするには、保存済みのリスト（デフォルト以外）を選択してください。');
        payload.presetId = presetId;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = '処理中...';
    Papa.parse(fileInput.files[0], {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const rawData = result.data.slice(1).map(r => ({ col1: String(r[0] || '').trim(), col2: String(r[1] || '').trim(), col3: String(r[2] || '').trim() })).filter(c => c.col1 && c.col2);
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
            if (confirm('現在のサーバーデータを上書きします。よろしいですか？')) socket.emit('host_import_data', data);
        } catch (error) { alert('ファイルの読み込みに失敗しました。'); }
    };
    reader.readAsText(file);
    event.target.value = '';
}
function handleDeletePreset() {
    const presetSelect = document.getElementById('preset-select');
    const presetId = presetSelect.value;
    if (!presetId || !presetId.startsWith('user_')) return alert('デフォルトの問題リストは削除できません。');
    const presetName = presetSelect.options[presetSelect.selectedIndex].text;
    if (confirm(`本当に「${presetName}」を削除しますか？`)) socket.emit('host_delete_preset', { presetId });
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
  if (gameMode === 'multi') {
    socket.emit("answer", { groupId, playerId, name: playerName, id });
  } else if (gameMode === 'single'){
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
  
  const resultDisplay = document.getElementById('round-result-display');
  if (resultDisplay) {
    if (state.answered && state.current?.roundResults) {
        const { first, second } = state.current.roundResults;
        let resultText = '';
        if (first) resultText += `🥇 1着: ${first}<br>`;
        if (second) resultText += `🥈 2着: ${second}<br>`;
        if (!first) resultText += '正解者なし... ';
        resultDisplay.innerHTML = resultText;
    } else {
        resultDisplay.innerHTML = '';
    }
  }

  const cardsGrid = document.getElementById('cards-grid');
  cardsGrid.innerHTML = '';
  const myPlayer = state.players.find(p => p.playerId === playerId);

  state.current?.cards.forEach(card => {
    const div = document.createElement("div");
    div.className = "card";
    
    let chosenByHtml = '';
    if (state.answered && card.chosenBy && card.chosenBy.length > 0) {
        chosenByHtml = `<div style="font-size:0.8em; color: #555;">${card.chosenBy.join(', ')}</div>`;
    }

    if (state.answered) {
        if (card.correctAnswer) {
            div.style.background = "gold";
            div.style.animation = "glow 1.5s infinite alternate";
        } else if (card.incorrect) {
            div.style.background = "crimson";
            div.style.color = "white";
        }
    }
    
    div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${card.term}</div>${chosenByHtml}`;
    
    if (!state.answered && !alreadyAnswered && myPlayer && myPlayer.hp > 0) {
        div.onclick = () => {
            submitAnswer(card.id);
            div.style.outline = '3px solid var(--primary-color)';
            div.style.transform = 'scale(0.95)';
            document.querySelectorAll('#cards-grid .card').forEach(c => c.onclick = null);
        };
    } else {
        div.style.cursor = 'default';
        if (myPlayer && myPlayer.hp <= 0) {
            div.style.opacity = '0.5';
        }
        div.onclick = null;
    }
    cardsGrid.appendChild(div);
  });
  
  const otherPlayers = state.players.filter(p => p.playerId !== playerId);
  const myInfoDiv = document.getElementById('my-info');
  if(myPlayer && myInfoDiv) {
    const streakText = myPlayer.streak > 1 ? `<span style="color: #dd6b20; font-weight: bold;">🔥${myPlayer.streak}連続!</span>` : '';
    myInfoDiv.innerHTML = `<h4>自分: ${myPlayer.name} (正解: ${myPlayer.correctCount ?? 0}) ${streakText}</h4>${renderHpBar(myPlayer.hp)}`;
  }
  const othersInfoDiv = document.getElementById('others-info');
  if (othersInfoDiv) {
      othersInfoDiv.innerHTML = '<h4>他のプレイヤー</h4>';
      otherPlayers.forEach(p => {
        const streakText = p.streak > 1 ? `<span style="color: #dd6b20; font-size: 0.8em; font-weight: bold;">🔥${p.streak}連続</span>` : '';
        othersInfoDiv.innerHTML += `<div><strong>${p.name} (正解: ${p.correctCount ?? 0}) ${streakText}</strong>${renderHpBar(p.hp)}</div>`;
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
  remainingIndices.forEach(index => textChars[index] = '？');
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
  if (isHost) { showCSVUploadUI(presets, fromEndScreen); } 
  else { showPlayerMenuUI(phase); }
});
socket.on('host_reconnect_success', () => { if (isHost) showHostUI(); });
socket.on('multiplayer_status_changed', (phase) => {
    const playerMenuButton = document.getElementById('multi-play-btn');
    if (playerMenuButton) {
        const multiPlayEnabled = ['GROUP_SELECTION', 'WAITING_FOR_NEXT_GAME', 'GAME_IN_PROGRESS'].includes(phase);
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
  if (gameMode !== 'multi' || !state) return;
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
    if (gameMode !== 'multi' || !state) return;
    groupId = state.groupId;
    showGameScreen(state);
});
socket.on("end", (ranking) => { if (gameMode === 'multi') showEndScreen(ranking); });
socket.on("host_state", (allGroups) => {
  const div = document.getElementById("hostStatus");
  if (!div) return;
  div.innerHTML = `<h3>各グループの状況</h3>` + Object.entries(allGroups).map(([gId, data]) => {
    if (data.players.length === 0) return '';
    const members = data.players.map(p => `<li>${p.name} (HP: ${p.hp}, 正解: ${p.correctCount}, 🔥:${p.streak})<br><small>今回のスコア: ${p.currentScore} | 累計スコア: ${p.totalScore}</small></li>`).join("");
    
    const modeSelector = `<label>モード: <select class="group-mode-selector" data-groupid="${gId}"><option value="normal" ${data.gameMode === 'normal' ? 'selected' : ''}>通常</option><option value="mask" ${data.gameMode === 'mask' ? 'selected' : ''}>応用</option></select></label>`;
    const timeLimitSelector = `<label>制限時間: <input type="number" class="group-time-limit-input" data-groupid="${gId}" value="${data.timeLimit}" min="5" max="60" style="width: 60px;"> 秒</label>`;
    const numCardsSelector = `<label>選択肢: <input type="number" class="group-num-cards-input" data-groupid="${gId}" value="${data.numCards}" min="3" max="20" style="width: 60px;"> 枚</label>`;

    return `<div style="margin-bottom:15px; padding: 10px; border: 1px solid #eee; border-radius: 4px;">
                <strong style="color:${data.locked ? 'red' : 'green'};">${gId} (${data.players.length}人)</strong>
                <div style="display: flex; flex-wrap: wrap; gap: 15px; margin-top: 5px;">${modeSelector}${timeLimitSelector}${numCardsSelector}</div>
                <ul>${members}</ul>
            </div>`;
  }).join("");

  document.querySelectorAll('.group-mode-selector').forEach(selector => {
    selector.onchange = (e) => socket.emit('host_set_group_mode', { groupId: e.target.dataset.groupid, gameMode: e.target.value });
  });
  document.querySelectorAll('.group-time-limit-input').forEach(input => {
    input.onchange = (e) => socket.emit('host_set_group_time_limit', { groupId: e.target.dataset.groupid, timeLimit: e.target.value });
  });
  document.querySelectorAll('.group-num-cards-input').forEach(input => {
    input.onchange = (e) => socket.emit('host_set_group_num_cards', { groupId: e.target.dataset.groupid, numCards: e.target.value });
  });
});

socket.on("global_ranking", (ranking) => {
    const div = document.getElementById("globalRanking");
    if (!div) return;
    div.innerHTML = `<h3><span style="font-size: 1.5em;">🌏</span> 全体ランキング (累計)</h3><ol style="padding-left: 20px;">${ranking.map((p, i) => `<li style="padding: 4px 0; border-bottom: 1px solid #eee;"><strong style="display: inline-block; width: 2em;">${i + 1}.</strong> ${p.name} <span style="float: right; font-weight: bold;">${p.totalScore}点</span></li>`).join("")}</ol>`;
});
socket.on("timer_start", ({ seconds }) => {
    const timerDiv = document.getElementById('countdown-timer');
    if (!timerDiv) return;
    if (countdownIntervalId) clearInterval(countdownIntervalId);
    let countdown = seconds;
    timerDiv.textContent = `⏳ ${countdown}s`;
    countdownIntervalId = setInterval(() => {
        countdown--;
        if (countdown >= 0) timerDiv.textContent = `⏳ ${countdown}s`;
        else { clearInterval(countdownIntervalId); countdownIntervalId = null; timerDiv.textContent = ""; }
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
    a.href = url; a.download = `rika_karuta_backup_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    alert('データの取り出しが完了しました。');
});
socket.on('import_data_response', ({ success, message }) => {
    alert(message);
    if (success) window.location.reload();
});

socket.on('presets_list', (presets) => {
  const container = document.getElementById('preset-list-container');
  if (!container) return;

  let html = '';
  if (gameMode === 'single' || gameMode === 'learning') {
      html = Object.entries(presets).map(([id, data], index) => {
          const isChecked = index === 0 ? 'checked' : '';
          return `<div><input type="radio" id="preset-${id}" name="preset-radio" value="${id}" ${isChecked}><label for="preset-${id}">${data.category} - ${data.name}</label></div>`;
      }).join('');
      
      container.innerHTML = html;
      
      if (gameMode === 'learning') {
        const learningOptions = document.getElementById('learning-options');
        if (learningOptions) learningOptions.style.display = 'block';
        const startBtn = document.getElementById('learning-start-btn');
        if(startBtn) {
            startBtn.onclick = startLearningMode;
        }
      }
  } else {
      container.innerHTML = html;
  }
});

socket.on('single_game_start', (initialState) => { showSinglePlayGameUI(); updateSinglePlayGameUI(initialState); });
socket.on('single_game_state', (state) => updateSinglePlayGameUI(state));
socket.on('single_game_end', (result) => showSinglePlayEndUI(result));
