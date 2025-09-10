// --- グローバル変数 ---
let socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000,
});
let playerId = localStorage.getItem('playerId');
let playerName = localStorage.getItem('playerName') || "";
let hostPlayerId = null;
let groupId = "";
let gameMode = 'multi';
let currentTimers = {}; // { ranking, read, unmask, countdown, singleGame }
let lastQuestionText = "";
let alreadyAnswered = false;

// --- DOM要素取得ヘルパー ---
const getEl = (id) => document.getElementById(id);
const query = (selector) => document.querySelector(selector);
const queryAll = (selector) => document.querySelectorAll(selector);
const container = () => getEl('app-container');

// --- ユーティリティ関数 ---
function amIHost() {
    return playerId && playerId === hostPlayerId;
}

function clearAllTimers() {
    Object.values(currentTimers).forEach(timerId => {
        if (timerId) clearInterval(timerId);
    });
    currentTimers = {};
    if (getEl('countdown-timer')) getEl('countdown-timer').textContent = '';
    console.log('All client timers cleared.');
}

function updateNavBar(backAction, showTop = true) {
    const navBar = getEl('nav-bar');
    const backBtn = getEl('nav-back-btn');
    const topBtn = getEl('nav-top-btn');

    if (backAction) {
        backBtn.style.display = 'block';
        backBtn.onclick = backAction;
    } else {
        backBtn.style.display = 'none';
    }

    topBtn.style.display = showTop ? 'block' : 'none';
    topBtn.onclick = showRoleSelectionUI;

    navBar.style.display = (backAction || showTop) ? 'flex' : 'none';
}

function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[&<>"']/g, function(match) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match];
    });
}


// --- アプリケーション初期化 ---
socket.on('connect', () => {
    console.log('✅ サーバーとの接続が確立しました。');
    if (!playerId) {
        socket.emit('request_new_player_id');
    } else {
        socket.emit('reconnect_player', { playerId, name: playerName });
        showRoleSelectionUI();
    }
});

socket.on('new_player_id_assigned', (newPlayerId) => {
    playerId = newPlayerId;
    localStorage.setItem('playerId', playerId);
    showRoleSelectionUI();
});

socket.on('force_reload', (message) => {
    alert(message);
    localStorage.removeItem('playerId');
    localStorage.removeItem('playerName');
    window.location.reload();
});

socket.on('error_message', (message) => {
    alert(`サーバーエラー: ${message}`);
});


// --- UI描画関数群 ---
function showRoleSelectionUI() {
    clearAllTimers();
    updateNavBar(null, false);
    container().innerHTML = `
        <div style="text-align: center;">
            <h1>理科カルタ</h1>
            <h2>参加方法を選択してください</h2>
            <div style="margin-top: 20px; margin-bottom: 30px;">
                <button id="host-btn" class="button-primary" style="font-size: 1.5em; height: 60px; margin: 10px;">ホストで参加</button>
                <button id="player-btn" class="button-secondary" style="font-size: 1.5em; height: 60px; margin: 10px;">プレイヤーで参加</button>
            </div>
        </div>`;
    
    getEl('host-btn').onclick = () => {
        socket.emit('host_join', { playerId });
    };
    getEl('player-btn').onclick = () => {
        socket.emit('request_game_phase');
    };
}

function showPlayerMenuUI(phase) {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    const multiPlayEnabled = phase === 'GROUP_SELECTION' || phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS';
    const statusText = {
        'INITIAL': '現在、ホストがゲームを準備中です...',
        'GROUP_SELECTION': 'ホストの準備が完了しました！',
        'WAITING_FOR_NEXT_GAME': 'ホストが次の問題を選択中です...',
        'GAME_IN_PROGRESS': 'ゲームが進行中です。クリックして復帰します。'
    }[phase] || '待機中...';
    
    container().innerHTML = `
        <div style="text-align: center;">
            <h2>プレイヤーメニュー</h2>
            <div style="margin-top: 20px; margin-bottom: 30px;">
                <button id="multi-play-btn" class="button-primary" style="font-size: 1.5em; height: 60px; margin: 10px;" ${!multiPlayEnabled ? 'disabled' : ''}>みんなでプレイ</button>
                <button id="single-play-btn" class="button-secondary" style="font-size: 1.5em; height: 60px; margin: 10px;">ひとりでプレイ</button>
            </div>
            <p id="multi-play-status" style="color: var(--text-muted);">${statusText}</p>
        </div>`;

    if (phase === 'GROUP_SELECTION') {
        getEl('multi-play-btn').onclick = showGroupSelectionUI;
    } else if (phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS') {
        getEl('multi-play-btn').onclick = () => socket.emit("rejoin_game", { playerId });
    }

    getEl('single-play-btn').onclick = showSinglePlaySetupUI;
}

function showCSVUploadUI(presets = {}, fromEndScreen = false) {
    clearAllTimers();
    updateNavBar(showRoleSelectionUI);
    gameMode = 'multi';
    const presetOptions = Object.entries(presets).map(([id, data]) =>
        `<option value="${id}">${escapeHTML(data.category)} - ${escapeHTML(data.name)}</option>`
    ).join('');
    container().innerHTML = `
        <h2>${fromEndScreen ? '次の問題を選択' : '1. 設定と問題のアップロード'}</h2>
        <fieldset>
            <legend>問題ソース</legend>
            <p>新しいCSVファイルをアップロードしてください。</p>
            <input type="file" id="csvFile" accept=".csv" />
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
    `;

    getEl('submit-settings').onclick = () => handleSettingsSubmit(fromEndScreen);
}

function showGroupSelectionUI() {
    clearAllTimers();
    updateNavBar(() => showPlayerMenuUI('GROUP_SELECTION'));
    let buttonsHTML = '<h2>2. グループを選択</h2>';
    for (let i = 1; i <= 10; i++) {
        buttonsHTML += `<button class="group-btn" data-group="${i}">グループ ${i}</button>`;
    }
    container().innerHTML = buttonsHTML;

    queryAll('.group-btn').forEach(btn => {
        btn.onclick = (e) => {
            groupId = "group" + e.target.dataset.group;
            socket.emit("join", { groupId, playerId });
            showNameInputUI();
        };
    });
}

function showNameInputUI() {
    clearAllTimers();
    updateNavBar(showGroupSelectionUI);
    container().innerHTML = `
        <h2>3. プレイヤー名を入力</h2>
        <input type="text" id="nameInput" placeholder="名前を入力..." value="${escapeHTML(playerName)}" />
        <button id="fix-name-btn" class="button-primary">決定</button>`;

    getEl('fix-name-btn').onclick = () => {
        const nameInput = getEl("nameInput");
        playerName = nameInput.value.trim();
        if (!playerName) return alert("名前を入力してください");
        localStorage.setItem('playerName', playerName);
        socket.emit("set_name", { groupId, playerId, name: playerName });
        container().innerHTML = `<p>${escapeHTML(groupId)}で待機中...</p>`;
    };
}

function showHostUI() {
    clearAllTimers();
    updateNavBar(() => socket.emit('request_game_phase', { fromEndScreen: true }));
    container().innerHTML = `
        <h2>👑 ホスト管理画面</h2>
        <div style="display:flex; flex-wrap: wrap; gap: 20px;">
            <div id="hostStatus" style="flex:2; min-width: 300px;"></div>
        </div>
        <hr/>
        <h3>🔀 グループ割り振り設定</h3>
        <div>
            <label>グループ数：<input id="groupCount" type="number" value="3" min="1" max="10"></label>
            <label>上位何グループにスコア上位を集中：<input id="topGroupCount" type="number" value="1" min="1"></label>
        </div>
        <div id="group-size-inputs" style="margin-top: 10px;"></div>
        <button id="submit-grouping-btn" style="margin-top:10px;">グループ割り振りを実行</button>
        <hr/>
        <button id="host-start-all-btn" class="button-primary" style="margin-top:10px;font-size:1.2em;">全グループでゲーム開始</button>
        <button id="change-settings-btn" class="button-outline" style="margin-top:10px;">問題・設定を変更する</button>
        <hr style="border-color: red; border-width: 2px; margin-top: 30px;" />
        <h3 style="color: red;">危険な操作</h3>
        <p>進行中のゲームデータ（プレイヤー情報、累計スコアなど）を削除し、アプリを初期状態に戻します。</p>
        <button id="host-reset-all-btn" style="background-color: crimson; color: white;">ゲームを完全リセット</button>
    `;

    const groupCountInput = getEl('groupCount');
    const groupSizeContainer = getEl('group-size-inputs');
    const updateGroupSizeInputs = () => {
        const count = parseInt(groupCountInput.value) || 0;
        groupSizeContainer.innerHTML = '';
        for (let i = 1; i <= count; i++) {
            groupSizeContainer.innerHTML += `<label style="margin-right: 15px;">グループ ${i} の人数：<input type="number" class="group-size-input" value="4" min="1"></label>`;
        }
    };
    groupCountInput.oninput = updateGroupSizeInputs;
    updateGroupSizeInputs();

    getEl('submit-grouping-btn').onclick = () => {
        const groupSizes = Array.from(queryAll('.group-size-input')).map(input => parseInt(input.value) || 0);
        socket.emit("host_assign_groups", {
            groupCount: parseInt(getEl("groupCount").value),
            topGroupCount: parseInt(getEl("topGroupCount").value),
            groupSizes: groupSizes
        });
    };
    getEl('host-start-all-btn').onclick = () => socket.emit('host_start');
    getEl('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
    getEl('host-reset-all-btn').onclick = () => {
        if (confirm('本当に進行中のゲームデータをリセットしますか？この操作は元に戻せません。')) {
            socket.emit('host_full_reset');
        }
    };

    currentTimers.ranking = setInterval(() => socket.emit("host_request_state"), 2000);
    socket.emit("host_request_state");
}

function showGameScreen(state) {
    clearAllTimers();
    updateNavBar(amIHost() ? showHostUI : showGroupSelectionUI);
    if (!getEl('game-area')) {
        container().innerHTML = `
            <div id="game-area">
                <div id="yomifuda"></div>
                <div id="cards-grid"></div>
                <hr>
                <div style="display: flex; flex-wrap: wrap; gap: 30px;">
                    <div id="my-info"></div>
                    <div id="others-info"></div>
                </div>
            </div>
            <div id="pause-overlay" class="pause-overlay" style="display: none;">
                <h2>一時停止中...</h2>
                <p>ホストがゲームを再開するまでお待ちください。</p>
            </div>
        `;
    }
    updateGameUI(state);
}

function showEndScreen(ranking) {
    clearAllTimers();
    updateNavBar(amIHost() ? showHostUI : () => showPlayerMenuUI('WAITING_FOR_NEXT_GAME'));
    const rankingHTML = ranking.map(p =>
        `<li>${escapeHTML(p.name)}（スコア: ${p.finalScore}｜累計: ${p.totalScore ?? 0}）</li>`
    ).join("");

    container().innerHTML = `
        <h2>🎉 ゲーム終了！</h2>
        <h3>今回の順位</h3>
        <ol id="end-screen-ranking" style="font-size: 1.2em;">${rankingHTML}</ol>
        ${amIHost() ? '<button id="change-settings-btn" class="button-primary">問題・設定を変更する</button>' : '<p>ホストが次のゲームを準備しています。</p>'}`;

    if (amIHost()) {
        getEl('change-settings-btn').onclick = () => socket.emit('host_preparing_next_game');
    }
}

function showSinglePlaySetupUI() {
    clearAllTimers();
    gameMode = 'single';
    updateNavBar(showPlayerMenuUI);
    container().innerHTML = `
        <h2>ひとりでプレイ（1分間タイムアタック）</h2>
        <p>名前を入力して、難易度と問題を選んでください。</p>
        <input type="text" id="nameInput" placeholder="名前を入力..." value="${escapeHTML(playerName)}" />
        <hr/>
        <h3>難易度</h3>
        <select id="difficulty-select">
            <option value="easy">かんたん（問題文が全文表示）</option>
            <option value="hard">むずかしい（問題文が隠される）</option>
        </select>
        <h3>問題リスト</h3>
        <div id="preset-list-container">読み込み中...</div>
        <hr/>
        <button id="single-start-btn" class="button-primary">ゲーム開始</button>`;

    getEl('single-start-btn').onclick = startSinglePlay;
    socket.emit('request_presets');
}

function showSinglePlayGameUI() {
    clearAllTimers();
    gameMode = 'single';
    updateNavBar(showSinglePlaySetupUI);
    if (!getEl('game-area')) {
        container().innerHTML = `
            <div id="game-area">
                <div id="yomifuda"></div>
                <div id="cards-grid"></div>
                <hr>
                <div id="single-player-info"></div>
            </div>`;
    }
    const timerDiv = getEl('countdown-timer');
    let timeLeft = 60;
    timerDiv.textContent = `残り時間: 1:00`;
    currentTimers.singleGame = setInterval(() => {
        timeLeft--;
        if (timeLeft < 0) {
            clearInterval(currentTimers.singleGame);
            currentTimers.singleGame = null;
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
    container().innerHTML = `
        <h2>タイムアップ！</h2>
        <h4>問題セット: ${escapeHTML(presetName)}</h4>
        <h3>今回のスコア: <span style="font-size: 1.5em; color: var(--primary-color);">${score}</span>点</h3>
        <p>自己ベスト: ${personalBest}点 ${score >= personalBest ? '🎉記録更新！' : ''}</p>
        <div style="display: flex; flex-wrap: wrap; gap: 20px; margin-top: 20px;">
            <div id="single-ranking" style="flex: 1; min-width: 300px;">
                <h3>全体ランキング トップ10</h3>
                <ol>${globalRanking.map((r, i) =>
                    `<li style="${r.isMe ? 'font-weight:bold; color:var(--primary-color);' : ''}">${i + 1}. ${escapeHTML(r.name)} - ${r.score}点</li>`
                ).join('')}</ol>
            </div>
        </div>
        <hr/>
        <button id="retry-btn" class="button-primary">もう一度挑戦</button>`;
    
    getEl('retry-btn').onclick = showSinglePlaySetupUI;
}


// --- イベントハンドラとロジック ---
function handleSettingsSubmit(isNextGame = false) {
    const fileInput = getEl("csvFile");
    if (!fileInput.files[0]) return alert("CSVファイルを選んでください");

    const settings = {
        numCards: parseInt(getEl("numCards").value),
        showSpeed: parseInt(getEl("speed").value),
        gameMode: query('input[name="game-mode"]:checked').value
    };

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
            
            socket.emit("set_cards_and_settings", { rawData, settings, isNextGame });
        }
    });
}

function startSinglePlay() {
    const nameInput = getEl("nameInput");
    playerName = nameInput.value.trim();
    if (!playerName) return alert("名前を入力してください");
    localStorage.setItem('playerName', playerName);
    const presetId = query('input[name="preset-radio"]:checked')?.value;
    if (!presetId) return alert('問題を選んでください');
    const difficulty = getEl('difficulty-select').value;
    socket.emit('start_single_play', { name: playerName, playerId, difficulty, presetId });
    container().innerHTML = `<p>ゲーム準備中...</p>`;
}


// --- UI更新関数 ---
function updateGameUI(state) {
    if (!state || !state.current) return;
    
    if (state.current.text !== lastQuestionText) {
        alreadyAnswered = false;
        lastQuestionText = state.current.text;
        
        const yomifudaDiv = getEl('yomifuda');
        if (yomifudaDiv) {
            if (state.gameMode === 'mask' && state.current.maskedIndices) {
                animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
            } else {
                animateNormalText('yomifuda', state.current.text, state.showSpeed);
            }
        }
    }

    const cardsGrid = getEl('cards-grid');
    if (cardsGrid) {
        cardsGrid.innerHTML = '';
        state.current.cards.forEach(card => {
            const div = document.createElement("div");
            div.className = "card";
            div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${escapeHTML(card.term)}</div>`;
            div.onclick = () => {
                if (!state.locked && !alreadyAnswered) {
                    alreadyAnswered = true; // 誤クリック防止
                    socket.emit("answer", { groupId, playerId, id: card.id });
                }
            };
            cardsGrid.appendChild(div);
        });
    }

    const myPlayer = state.players.find(p => p.playerId === playerId);
    const otherPlayers = state.players.filter(p => p.playerId !== playerId);

    if (getEl('my-info') && myPlayer) {
        getEl('my-info').innerHTML = `<h4>自分: ${escapeHTML(myPlayer.name)} (正解: ${myPlayer.correctCount ?? 0})</h4>${renderHpBar(myPlayer.hp)}`;
    }
    if (getEl('others-info')) {
        getEl('others-info').innerHTML = '<h4>他のプレイヤー</h4>' + otherPlayers.map(p =>
            `<div><strong>${escapeHTML(p.name)} (正解: ${p.correctCount ?? 0})</strong>${renderHpBar(p.hp)}</div>`
        ).join('');
    }
}

function updateSinglePlayGameUI(state) {
    alreadyAnswered = false;
    const yomifudaDiv = getEl('yomifuda');
    if (yomifudaDiv && state.current?.text) {
        if (state.difficulty === 'hard') {
            animateMaskedText('yomifuda', state.current.text, state.current.maskedIndices);
        } else {
            yomifudaDiv.textContent = state.current.text;
        }
    }
    const cardsGrid = getEl('cards-grid');
    cardsGrid.innerHTML = '';
    state.current?.cards.forEach(card => {
        const div = document.createElement("div");
        div.className = "card";
        if (card.correct) div.style.background = "gold";
        if (card.incorrect) div.style.background = "crimson";
        div.innerHTML = `<div style="font-weight:bold; font-size:1.1em;">${escapeHTML(card.term)}</div>`;
        div.onclick = () => { if (!alreadyAnswered) { alreadyAnswered=true; socket.emit("single_answer", { id: card.id }); } };
        cardsGrid.appendChild(div);
    });
    getEl('single-player-info').innerHTML = `<h4>スコア: ${state.score}</h4>`;
}

function renderHpBar(hp) {
    const hpPercent = Math.max(0, hp / 20 * 100);
    let hpColor = (hp <= 5) ? "#e53e3e" : (hp <= 10) ? "#dd6b20" : "#48bb78";
    return `
      <div style="font-size: 0.9em; margin-bottom: 4px;">HP: ${hp} / 20</div>
      <div class="hp-bar-container">
        <div class="hp-bar-inner" style="width: ${hpPercent}%; background-color: ${hpColor};"></div>
      </div>`;
}

function animateNormalText(elementId, text, speed) {
    const element = getEl(elementId);
    if (!element) return;
    if (currentTimers.read) clearInterval(currentTimers.read);
    element.textContent = "";
    let i = 0;
    currentTimers.read = setInterval(() => {
        i += 5;
        if (i >= text.length) {
            element.textContent = text;
            clearInterval(currentTimers.read);
            currentTimers.read = null;
            socket.emit("read_done", groupId);
        } else {
            element.textContent = text.slice(0, i);
        }
    }, speed);
}

function animateMaskedText(elementId, text, maskedIndices) {
    const element = getEl(elementId);
    if (!element) return;
    if (currentTimers.unmask) clearInterval(currentTimers.unmask);
    let textChars = text.split('');
    let remainingIndices = [...maskedIndices];
    for (const index of remainingIndices) {
        if (textChars[index] !== ' ' && textChars[index] !== '　') textChars[index] = '？';
    }
    element.textContent = textChars.join('');
    const revealSpeed = remainingIndices.length > 0 ? 20000 / remainingIndices.length : 200;
    currentTimers.unmask = setInterval(() => {
        if (remainingIndices.length === 0) {
            clearInterval(currentTimers.unmask);
            currentTimers.unmask = null;
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


// --- Socket.IO イベントリスナー ---
socket.on('game_phase_response', ({ phase, presets, fromEndScreen, hostPlayerId: serverHostId }) => {
    hostPlayerId = serverHostId;
    if (amIHost()) {
        showCSVUploadUI(presets, fromEndScreen);
    } else {
        showPlayerMenuUI(phase);
    }
});

socket.on('multiplayer_status_changed', (phase) => {
    const multiPlayStatus = getEl('multi-play-status');
    if (multiPlayStatus) {
        const multiPlayEnabled = phase === 'GROUP_SELECTION' || phase === 'WAITING_FOR_NEXT_GAME' || phase === 'GAME_IN_PROGRESS';
        getEl('multi-play-btn').disabled = !multiPlayEnabled;
        const statusText = {
            'INITIAL': '現在、ホストがゲームを準備中です...',
            'GROUP_SELECTION': 'ホストの準備が完了しました！',
            'WAITING_FOR_NEXT_GAME': 'ホストが次の問題を選択中です...',
            'GAME_IN_PROGRESS': 'ゲームが進行中です。クリックして復帰します。'
        }[phase] || '待機中...';
        multiPlayStatus.textContent = statusText;
    }
});

socket.on('host_setup_done', () => {
    if (amIHost()) showHostUI();
});

socket.on("assigned_group", (newGroupId) => {
    groupId = newGroupId;
    container().innerHTML = `<h2>あなたは <strong>${escapeHTML(groupId)}</strong> に割り振られました</h2><p>ホストが開始するまでお待ちください。</p>`;
});

socket.on("state", (state) => {
    if (!state) return;
    const isGameScreenActive = getEl('game-area');
    if (state.current && !isGameScreenActive && playerName) {
        showGameScreen(state);
    } else if (isGameScreenActive) {
        updateGameUI(state);
    }
});

socket.on("rejoin_game", (state) => {
    if (!state) return;
    groupId = state.groupId;
    showGameScreen(state);
});

socket.on("end", (ranking) => {
    showEndScreen(ranking);
});

socket.on("host_state", (allGroups) => {
    const div = getEl("hostStatus");
    if (!div) return;
    div.innerHTML = '<h3>各グループの状況</h3>' + Object.entries(allGroups).map(([gId, data]) => {
        if (data.players.length === 0) return '';
        const members = data.players.map(p =>
            `<li style="color: ${p.isOnline ? 'inherit' : '#aaa'};">${escapeHTML(p.name)} (HP: ${p.hp}, 正解: ${p.correctCount}, 累計: ${p.totalScore}) ${p.isOnline ? '' : '(オフライン)'}</li>`
        ).join("");

        return `
            <div style="margin-bottom:15px; padding: 10px; border: 1px solid #eee; border-radius: 4px;">
                <strong style="color:${data.locked ? 'red' : 'green'};">${gId} (${data.players.length}人)</strong>
                <button class="pause-btn" data-groupid="${gId}">${data.isPaused ? '再開' : '一時停止'}</button>
                <ul>${members}</ul>
            </div>`;
    }).join("");

    queryAll('.pause-btn').forEach(btn => {
        btn.onclick = (e) => socket.emit('host_toggle_pause', e.target.dataset.groupid);
    });
});

socket.on("timer_start", ({ seconds }) => {
    const timerDiv = getEl('countdown-timer');
    if (!timerDiv) return;
    if (currentTimers.countdown) clearInterval(currentTimers.countdown);
    let countdown = seconds;
    timerDiv.textContent = `⏳ ${countdown}s`;
    currentTimers.countdown = setInterval(() => {
        countdown--;
        if (countdown >= 0) {
            timerDiv.textContent = `⏳ ${countdown}s`;
        } else {
            clearInterval(currentTimers.countdown);
            currentTimers.countdown = null;
            timerDiv.textContent = "";
        }
    }, 1000);
});

socket.on("correct_answer", ({ playerId: correctPlayerId, name, cardId, updatedPlayers }) => {
    const cardElements = queryAll('.card');
    cardElements.forEach(cardEl => {
        if (cardEl.innerHTML.includes(cardId)) { // This is a heuristic, better to use data attributes
            cardEl.style.background = "gold";
            cardEl.innerHTML += `<div style="font-size:0.8em; color: black;">${escapeHTML(name)}</div>`;
        }
    });

    updatedPlayers.forEach(p => {
        const playerInfoEl = Array.from(queryAll('#my-info, #others-info div')).find(el => el.textContent.includes(p.name));
        if (playerInfoEl) {
            playerInfoEl.innerHTML = `<strong>${escapeHTML(p.name)} (正解: ${p.correctCount ?? 0})</strong>${renderHpBar(p.hp)}`;
        }
    });
});

socket.on("incorrect_answer", ({ name, cardId, updatedPlayer }) => {
    const cardElements = queryAll('.card');
    cardElements.forEach(cardEl => {
        if (cardEl.innerHTML.includes(cardId)) { // This is a heuristic
            cardEl.style.background = "crimson";
            cardEl.style.color = "white";
            cardEl.innerHTML += `<div style="font-size:0.8em;">${escapeHTML(name)}</div>`;
        }
    });
    
    const playerInfoEl = Array.from(queryAll('#my-info, #others-info div')).find(el => el.textContent.includes(updatedPlayer.name));
    if (playerInfoEl) {
        playerInfoEl.innerHTML = `<strong>${escapeHTML(updatedPlayer.name)} (正解: ${updatedPlayer.correctCount ?? 0})</strong>${renderHpBar(updatedPlayer.hp)}`;
    }
});


socket.on("answer_reveal", (cards) => {
    cards.forEach(cardInfo => {
        const cardElements = queryAll('.card');
        cardElements.forEach(cardEl => {
            if (cardEl.textContent.includes(cardInfo.term) && cardInfo.isCorrectAnswer) {
                cardEl.style.background = "lightgreen";
                cardEl.style.border = "2px solid green";
            }
        });
    });
});

socket.on('game_paused_status', (isPaused) => {
    const overlay = getEl('pause-overlay');
    if (overlay) {
        overlay.style.display = isPaused ? 'flex' : 'none';
    }
});

// --- シングルプレイ用リスナー ---
socket.on('presets_list', (presets) => {
    const container = getEl('preset-list-container');
    if (!container) return;
    const radioButtons = Object.entries(presets).map(([id, data], index) => `
        <div>
            <input type="radio" id="preset-${id}" name="preset-radio" value="${id}" ${index === 0 ? 'checked' : ''}>
            <label for="preset-${id}">${escapeHTML(data.category)} - ${escapeHTML(data.name)}</label>
        </div>`
    ).join('');
    container.innerHTML = radioButtons;
});

socket.on('single_game_start', (initialState) => {
    showSinglePlayGameUI();
    updateSinglePlayGameUI(initialState);
});

socket.on('single_game_state', (state) => {
    updateSinglePlayGameUI(state);
});

socket.on('single_game_end', (result) => {
    showSinglePlayEndUI(result);
});
