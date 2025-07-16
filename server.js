// server.js (修正完了版)

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// --- グローバル変数 ---
let hostSocketId = null;
let globalCards = [];
let globalSettings = {
  maxQuestions: 10,
  numCards: 5,
  showSpeed: 2000
};
let gamePhase = 'INITIAL';

// ゲーム状態とプレイヤー情報を管理
const states = {}; // ゲームごとの一時的な状態 (HP, 現在の問題など)
const groups = {}; // ゲームをまたいで保持する永続的な情報 (プレイヤーリスト, 累計スコアなど)


// -------------------------------------------------------------------
// ▼▼▼ ヘルパー関数群 (ロジックを部品化して見通しを良くする) ▼▼▼
// -------------------------------------------------------------------

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function initState(groupId) {
  return {
    groupId,
    players: [],
    questionCount: 0,
    maxQuestions: globalSettings.maxQuestions,
    numCards: globalSettings.numCards,
    showSpeed: globalSettings.showSpeed,
    current: null,
    answered: false,
    waitingNext: false,
    misClicks: [],
    usedQuestions: [],
    readDone: new Set(),
    readTimer: null,
    eliminatedOrder: []
  };
}

function sanitizeState(state) {
  if (!state) return null; // stateがない場合はnullを返す
  return {
    groupId: state.groupId,
    players: state.players,
    questionCount: state.questionCount,
    maxQuestions: state.maxQuestions,
    current: state.current
      ? {
          ...state.current,
          pointValue: state.current.point,
          cards: state.current.cards
        }
      : null,
    misClicks: state.misClicks,
    showSpeed: state.showSpeed,
    waitingNext: state.waitingNext,
    answered: state.answered,
    locked: state.locked
  };
}

function getHostState() {
  const result = {};
  for (const [groupId, group] of Object.entries(groups)) {
    const state = states[groupId];
    result[groupId] = {
      locked: state?.locked ?? false,
      players: group.players.map(p => ({
        name: p.name,
        // ゲーム中のHPや正解数はstateから、累計スコアはgroupから取得
        hp: state?.players.find(sp => sp.id === p.id)?.hp ?? 20,
        correctCount: state?.players.find(sp => sp.id === p.id)?.correctCount ?? 0,
        totalScore: p.totalScore ?? 0
      }))
    };
  }
  return result;
}

function checkGameEnd(groupId) {
  const state = states[groupId];
  if (!state || state.locked) return;

  const survivors = state.players.filter(p => p.hp > 0);

  if (survivors.length <= 1) { // 0人または1人で終了
    state.locked = true;
    const eliminated = [...(state.eliminatedOrder || [])].reverse();

    const ranked = [
      ...(survivors.length === 1 ? [survivors[0]] : []),
      ...eliminated
        .map(name => state.players.find(p => p.name === name))
        .filter(p => p !== undefined)
    ];

    const alreadyUpdated = new Set();
    ranked.forEach((p, i) => {
      const correctCount = p.correctCount || 0;
      let bonus = 0;
      if (i === 0) bonus = 200;
      else if (i === 1) bonus = 100;
      p.finalScore = correctCount * 10 + bonus;

      const gPlayer = groups[groupId]?.players.find(gp => gp.id === p.id);
      if (gPlayer && !alreadyUpdated.has(gPlayer.id)) {
        gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
        p.totalScore = gPlayer.totalScore;
        alreadyUpdated.add(gPlayer.id);
      } else {
        p.totalScore = gPlayer?.totalScore ?? p.finalScore;
      }
    });

    ranked.sort((a, b) => b.finalScore - a.finalScore);
    io.to(groupId).emit("end", ranked);
  }
}

// server.js の修正箇所

function nextQuestion(groupId) {
    const state = states[groupId];
    if (!state || state.locked) return;

    if (state.readTimer) {
        clearTimeout(state.readTimer);
        state.readTimer = null;
    }

    const remaining = globalCards.filter(q => !state.usedQuestions.includes(q.text.trim() + q.number));

    // ▼▼▼ ここからが重要な修正 ▼▼▼
    // 問題が尽きた、または規定問題数に達した場合の終了処理
    if (remaining.length === 0 || state.questionCount >= state.maxQuestions) {
        state.locked = true; // まずゲームをロック
        
        // 現在のプレイヤーをHPと正解数でソートして、その時点でのランキングを作成
        const finalRanking = [...state.players].sort((a, b) => {
            if (b.hp !== a.hp) {
                return b.hp - a.hp; // 1. HPが高いプレイヤーが上位
            }
            // HPが同じ場合は、正解数が多いプレイヤーが上位
            return (b.correctCount || 0) - (a.correctCount || 0);
        });
        
        // 最終スコアを計算
        const alreadyUpdated = new Set();
        finalRanking.forEach((p, i) => {
            const correctCount = p.correctCount || 0;
            let bonus = 0;
            // HP順でボーナスを付与する
            if (i === 0) bonus = 200; // 1位
            else if (i === 1) bonus = 100; // 2位
            
            p.finalScore = (correctCount * 10) + bonus;

            // 累計スコアも更新
            const gPlayer = groups[groupId]?.players.find(gp => gp.id === p.id);
            if (gPlayer && !alreadyUpdated.has(gPlayer.id)) {
                gPlayer.totalScore = (gPlayer.totalScore || 0) + p.finalScore;
                p.totalScore = gPlayer.totalScore;
                alreadyUpdated.add(gPlayer.id);
            } else {
                p.totalScore = gPlayer?.totalScore ?? p.finalScore;
            }
        });

        // 最終スコアで再度ソートして、正しい順位に並べ替える
        finalRanking.sort((a, b) => b.finalScore - a.finalScore);

        console.log(`ゲーム終了: 問題数上限または問題切れのため。 Group: ${groupId}`);
        io.to(groupId).emit("end", finalRanking); // 計算した正しいランキングを送信
        return; // これ以上、問題は出さないので処理を終了
    }
    // ▲▲▲ ここまでが修正箇所 ▲▲▲

    // 問題がまだある場合は、通常通り次の問題を出題する
    const question = remaining[Math.floor(Math.random() * remaining.length)];
    const key = question.text.trim() + question.number;
    state.usedQuestions.push(key);

    const distractors = shuffle(globalCards.filter(c => c.number !== question.number)).slice(0, state.numCards - 1);
    const cards = shuffle([...distractors, question]);

    let point = 1;
    const rand = Math.random();
    if (rand < 0.05) point = 5;
    else if (rand < 0.2) point = 3;
    else if (rand < 0.6) point = 2;

    state.current = {
        text: question.text,
        answer: question.number,
        point,
        cards: cards.map(c => ({ number: c.number, term: c.term }))
    };
    state.questionCount++;
    state.waitingNext = false;
    state.answered = false;
    state.readDone = new Set();
    state.misClicks = [];

    io.to(groupId).emit("state", sanitizeState(state));
}


// -------------------------------------------------------------------
// ▼▼▼ ここからがメインの接続処理 ▼▼▼
// -------------------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`✅ プレイヤーが接続しました: ${socket.id}`);

// クライアントから現在のゲームフェーズを尋ねられたときの応答
  socket.on('request_game_phase', () => {
    socket.emit('game_phase_response', { phase: gamePhase });
  });
  
  // --- イベントリスナーの登録 (ここから下はすべて並列) ---

  socket.on("set_cards_and_settings", ({ cards, settings }) => {
    globalCards = [...cards];
    globalSettings = { ...globalSettings, ...settings };
    
    // 全てのゲーム状態をリセット
    Object.keys(states).forEach(key => delete states[key]);
    Object.keys(groups).forEach(key => delete groups[key]);
    gamePhase = 'GROUP_SELECTION';
    
    io.emit("start_group_selection");
  });

  socket.on("join", (groupId) => {
    socket.join(groupId);
    if (!groups[groupId]) groups[groupId] = { players: [] };
    if (!groups[groupId].players.find(p => p.id === socket.id)) {
      groups[groupId].players.push({ id: socket.id, name: "未設定", hp: 20, score: 0, correctCount: 0, totalScore: 0 });
    }
    
    if (!states[groupId]) states[groupId] = initState(groupId);
    const state = states[groupId];
    if (!state.players.find(p => p.id === socket.id)) {
      state.players.push({ id: socket.id, name: "未設定", hp: 20 });
    }
    
    io.to(groupId).emit("state", sanitizeState(state));
  });

  socket.on("leave_group", ({ groupId }) => {
    socket.leave(groupId);
    if (groups[groupId]) {
      groups[groupId].players = groups[groupId].players.filter(p => p.id !== socket.id);
    }
    if (states[groupId]) {
      states[groupId].players = states[groupId].players.filter(p => p.id !== socket.id);
    }
    console.log(`🚪 ${socket.id} が ${groupId} を離脱`);
  });

  socket.on("set_name", ({ groupId, name }) => {
    const state = states[groupId];
    if (state?.players) {
        const player = state.players.find(p => p.id === socket.id);
        if (player) player.name = name;
    }
    const gplayer = groups[groupId]?.players.find(p => p.id === socket.id);
    if (gplayer) gplayer.name = name;
    // 名前が設定されたら、グループの最新状態をグループ全員に送信する。
  // これにより、途中参加者が他のプレイヤーに認識され、
  // 本人もゲームが始まっていれば即座にゲーム画面に遷移できる。
  if (state) {
    io.to(groupId).emit("state", sanitizeState(state));
  }
  });


  
  socket.on("read_done", (groupId) => {
    const state = states[groupId];
    if (!state || !state.current || state.answered) return;
  
    if (!state.readDone) state.readDone = new Set();
    state.readDone.add(socket.id);
  
    const livingPlayers = state.players.filter(p => p.hp > 0);
    const allLivingPlayersRead = livingPlayers.every(p => state.readDone.has(p.id));
  
    const latestText = state.current.text;
  
    // 全員が読み終わったら即タイマー開始
    if (allLivingPlayersRead && !state.readTimer) {
      if (state.readTimer) clearTimeout(state.readTimer); // 念のためクリア
      
      io.to(groupId).emit("timer_start", { seconds: 30 });
      state.readTimer = setTimeout(() => {
        if (!state.answered && !state.waitingNext && state.current?.text === latestText) {
          state.waitingNext = true;
          io.to(groupId).emit("state", sanitizeState(state));
          setTimeout(() => nextQuestion(groupId), 3000);
        }
      }, 30000);
    }
  });

  socket.on("host_join", () => {
    hostSocketId = socket.id;
    console.log("👑 ホストが接続しました:", socket.id);
  });

  socket.on("host_request_state", () => {
    if (socket.id === hostSocketId) {
      socket.emit("host_state", getHostState());
    }
  });
  
  socket.on("request_global_ranking", () => {
      const allPlayers = [];
      for (const group of Object.values(groups)) {
          for (const p of group.players) {
              if (p.name !== "未設定") {
                  allPlayers.push({ name: p.name, totalScore: p.totalScore || 0 });
              }
          }
      }
      const sorted = allPlayers.sort((a, b) => b.totalScore - a.totalScore);
      socket.emit("global_ranking", sorted);
  });

  socket.on("host_start", () => {
    if (socket.id !== hostSocketId) return;
    console.log("▶ ホストが全体スタートを実行");

    for (const groupId of Object.keys(groups)) {
        if (groups[groupId].players.length === 0) continue;

        states[groupId] = initState(groupId);
        const state = states[groupId];
        const group = groups[groupId];

        state.players = group.players.map(p => ({ id: p.id, name: p.name, hp: 20, score: 0, correctCount: 0 }));
        group.players.forEach(p => { p.hp = 20; p.score = 0; p.correctCount = 0; });

        nextQuestion(groupId);
    }
  });

 // server.js の修正箇所

  socket.on("host_assign_groups", ({ groupCount, playersPerGroup, topGroupCount }) => {
    if (socket.id !== hostSocketId) return;

    // 1. 参加中の全プレイヤーを収集し、累計スコア順に並べる
    const allPlayers = Object.values(groups)
        .flatMap(g => g.players)
        .filter(p => p.name !== "未設定");
    allPlayers.sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    // 2. 新しいグループの枠を用意する
    const newGroupsConfig = {};
    for (let i = 1; i <= groupCount; i++) {
      newGroupsConfig[`group${i}`] = [];
    }

    // 3. 【重要】スコア上位者とそれ以外に分ける
    const topPlayerCount = topGroupCount * playersPerGroup;
    const topPlayers = allPlayers.slice(0, topPlayerCount);
    const otherPlayers = allPlayers.slice(topPlayerCount);

    // 4. 【重要】上位者を優先的に割り振る
    topPlayers.forEach((player, index) => {
      // グループ1, グループ2, ... グループtopGroupCount へ順番に割り振る
      const targetGroupId = `group${(index % topGroupCount) + 1}`;
      newGroupsConfig[targetGroupId].push(player);
    });

    // 5. 【重要】残りのプレイヤーをランダムに割り振る
    shuffle(otherPlayers).forEach((player, index) => {
        // 上位グループ以外のグループに順番に割り振る
        const targetGroupIndex = topGroupCount + (index % (groupCount - topGroupCount));
        const targetGroupId = `group${targetGroupIndex + 1}`;
        // もしグループが存在しない場合は、最後のグループに入れる（安全対策）
        if (newGroupsConfig[targetGroupId]) {
            newGroupsConfig[targetGroupId].push(player);
        } else {
            newGroupsConfig[`group${groupCount}`].push(player);
        }
    });

    // 6. 古いグループとStateを完全にリセット
    Object.keys(groups).forEach(key => delete groups[key]);
    Object.keys(states).forEach(key => delete states[key]);

    // 7. 新しい設定でグループとStateを再構築
    for (const [groupId, players] of Object.entries(newGroupsConfig)) {
        groups[groupId] = { players };
        states[groupId] = initState(groupId);
        states[groupId].players = players.map(p => ({ id: p.id, name: p.name, hp: 20, score: 0, correctCount: 0 }));
    }

    // 8. 各プレイヤーに新しいグループを通知し、Socket.IOのルームを再参加させる
    for (const [groupId, group] of Object.entries(groups)) {
        for (const p of group.players) {
            const socketInstance = io.sockets.sockets.get(p.id);
            if (socketInstance) {
                // 一旦すべてのルームから退出させる（古いグループから抜けるため）
                for (const room of socketInstance.rooms) {
                    if (room !== p.id) socketInstance.leave(room);
                }
                // 新しいグループのルームに参加させる
                socketInstance.join(groupId);
                // 新しいグループを本人に通知
                socketInstance.emit("assigned_group", groupId);
            }
        }
    }
    console.log("✅ グループ割り振り完了");
    
    // ホストに最新の状態を即時送信
    if (hostSocketId) {
        io.to(hostSocketId).emit("host_state", getHostState());
    }
  });

  socket.on("answer", ({ groupId, name, number }) => {
    const state = states[groupId];
    const group = groups[groupId];
    if (!state || !group || !state.current || state.answered || state.locked) return;
    
    const playerState = state.players.find(p => p.name === name);
    if (!playerState || playerState.hp <= 0) return;

    const correct = state.current.answer === number;
    const point = state.current.point;

    if (correct) {
        state.answered = true;
        playerState.correctCount = (playerState.correctCount || 0) + 1;
        
        const groupPlayer = group.players.find(p => p.id === playerState.id);
        if(groupPlayer) groupPlayer.score += point;

        state.current.cards.find(c => c.number === number).correct = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;
        
        state.players.forEach(p => {
            if (p.name !== name) {
                p.hp = Math.max(0, p.hp - point);
                if (p.hp <= 0 && !state.eliminatedOrder.includes(p.name)) {
                    state.eliminatedOrder.push(p.name);
                }
            }
        });
        
        io.to(groupId).emit("state", sanitizeState(state));
        checkGameEnd(groupId);
        if (!state.locked) setTimeout(() => nextQuestion(groupId), 3000);

    } else {
        playerState.hp -= point;
        if (playerState.hp <= 0) {
            playerState.hp = 0;
            if (!state.eliminatedOrder.includes(playerState.name)) {
                state.eliminatedOrder.push(playerState.name);
            }
        }
        state.misClicks.push({ name, number });
        state.current.cards.find(c => c.number === number).incorrect = true;
        state.current.cards.find(c => c.number === number).chosenBy = name;

        // 全員お手つきチェック
        const activePlayers = state.players.filter(p => p.hp > 0);
        const misClickedPlayers = new Set(state.misClicks.map(mc => mc.name));
        if (activePlayers.every(p => misClickedPlayers.has(p.name))) {
            state.waitingNext = true;
            const correctCard = state.current.cards.find(c => c.number === state.current.answer);
            if(correctCard) correctCard.correctAnswer = true;
            
            io.to(groupId).emit("state", sanitizeState(state));
            setTimeout(() => nextQuestion(groupId), 3000);
        } else {
            io.to(groupId).emit("state", sanitizeState(state));
            checkGameEnd(groupId);
        }
    }
  });

  // ✅ 接続が切れたときの処理 (最重要)
  socket.on("disconnect", () => {
    console.log(`🔌 プレイヤーが切断しました: ${socket.id}`);
    for (const groupId in groups) {
      const playerIndex = groups[groupId].players.findIndex(p => p.id === socket.id);
      if (playerIndex > -1) {
        const playerName = groups[groupId].players[playerIndex].name;
        console.log(`👻 ${groupId} から ${playerName} を削除します`);

        groups[groupId].players.splice(playerIndex, 1);
        
        const state = states[groupId];
        if (state?.players) {
          const statePlayerIndex = state.players.findIndex(p => p.id === socket.id);
          if (statePlayerIndex > -1) {
            state.players.splice(statePlayerIndex, 1);
          }

          if (state && !state.locked && playerName !== "未設定" && !state.eliminatedOrder.includes(playerName)) {
            state.eliminatedOrder.push(playerName);
            checkGameEnd(groupId);
          }
          
          io.to(groupId).emit("state", sanitizeState(state));
        }
        
        if (hostSocketId) {
          io.to(hostSocketId).emit("host_state", getHostState());
        }
        break;
      }
    }
  });

}); // ◀︎◀︎◀︎ io.on("connection", ...); はここで閉じる


// サーバーを起動
const PORT = process.env.PORT || 80; // ← ポートを3000から80に変更
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
