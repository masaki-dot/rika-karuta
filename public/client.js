let socket = io();
let playerName = "";
let groupId = "";
let showSpeed = 2000;
let maxQuestions = 10;
let numCards = 5;
let loadedCards = [];
let yomifudaAnimating = false;
let lastYomifudaText = "";
let playerNameFixed = false;
let locked = false;

function showGroupSelectUI() {
  document.body.innerHTML = `
    <h2>CSVと共通設定をアップロード</h2>
    <input type="file" id="csvFile" accept=".csv" />
    <br/>
    問題数: <input id="maxQuestions" type="number" value="10" />
    取り札数: <input id="numCards" type="number" value="5" />
    表示速度(ms/5文字): <input id="speed" type="number" value="2000" />
    <div id="groupButtons"></div>
    <div id="userCountDisplay">接続中: 0人</div>
  `;

  document.getElementById("csvFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    Papa.parse(file, {
      header: false,
      skipEmptyLines: true,
      complete: (result) => {
        const rows = result.data.slice(1);
        loadedCards = rows.map(r => ({
          number: String(r[0]).trim(),
          term: String(r[1]).trim(),
          text: String(r[2]).trim()
        })).filter(c => c.term && c.text);

        maxQuestions = Number(document.getElementById("maxQuestions").value);
        numCards = Number(document.getElementById("numCards").value);
        showSpeed = Number(document.getElementById("speed").value);

        socket.emit("set_cards_and_settings", {
          cards: loadedCards,
          settings: { maxQuestions, numCards, showSpeed }
        });
      }
    });
  });
}

socket.on("start_group_selection", () => {
  document.body.innerHTML = "<h2>グループ選択</h2><div id='groupButtons'></div>";
  const area = document.getElementById("groupButtons");
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement("button");
    btn.textContent = "グループ " + i;
    btn.onclick = () => {
      groupId = "group" + i;
      socket.emit("join", groupId);
      showNameInputUI();
    };
    area.appendChild(btn);
  }
});

function showNameInputUI() {
  document.body.innerHTML = `
    <h2>プレイヤー名を入力</h2>
    <input id="nameInput" />
    <button onclick="fixPlayerName()">決定</button>
    <div id="game"></div>
  `;
}

function fixPlayerName() {
  const name = document.getElementById("nameInput").value.trim();
  if (!name) return alert("名前を入力してください");

  playerName = name;
  playerNameFixed = true;
  document.getElementById("nameInput").disabled = true;

  document.getElementById("game").innerHTML = `
    <button onclick="startGame()">スタート</button>
  `;
}

function startGame() {
  if (!playerNameFixed) return alert("名前を決定してください");

  maxQuestions = Number(document.getElementById("maxQuestions")?.value || 10);
  numCards = Number(document.getElementById("numCards")?.value || 5);
  showSpeed = Number(document.getElementById("speed")?.value || 2000);

  socket.emit("start", {
    groupId,
    numCards,
    maxQuestions,
    playerName
  });
}

socket.on("state", (state) => {
  if (!state.current) return;
  locked = false;

  if (state.showSpeed) showSpeed = state.showSpeed;
  if (yomifudaAnimating && lastYomifudaText === state.current.text) {
    updateGameUI(state, false);
  } else {
    lastYomifudaText = state.current.text;
    yomifudaAnimating = false;
    updateGameUI(state, true);
  }
});

socket.on("lock", () => {
  locked = true;
});

socket.on("end", (players) => {
  const root = document.getElementById("game");
  root.innerHTML += `<h2>ゲーム終了！</h2><ul>` +
    players.map(p => `<li>${p.name}: HP ${p.hp}</li>`).join("") +
    `</ul>`;
});

socket.on("user_count", (count) => {
  const div = document.getElementById("userCountDisplay");
  if (div) div.textContent = `接続中: ${count}人`;
});

function updateGameUI(state, showYomifuda = true) {
  const root = document.getElementById("game");
  root.innerHTML = `
    <h3>問題 ${state.questionCount}/${state.maxQuestions}</h3>
    <div>得点：HP ${getMyHP(state.players)}</div>
    <div>この問題の得点: ${state.current.pointValue}</div>
    <div id="yomifuda"></div>
    <div id="cards" style="display:flex;flex-wrap:wrap;"></div>
    <div><strong>他のプレイヤー:</strong><ul>${
      state.players.filter(p => p.name !== playerName).map(p =>
        `<li>${p.name}: HP ${p.hp}</li>`).join("")
    }</ul></div>
  `;

  const yomifuda = document.getElementById("yomifuda");
  if (showYomifuda) {
    yomifuda.textContent = "";
    setTimeout(() => showYomifudaAnimated(state.current.text), 100);
  } else {
    yomifuda.textContent = lastYomifudaText;
  }

  const cardsDiv = document.getElementById("cards");
  state.current.cards.forEach(c => {
    const div = document.createElement("div");
    div.innerHTML = `<strong>${c.term}</strong><br>${c.number}`;
    div.style = "border:1px solid #000;margin:5px;padding:10px;cursor:pointer;";
    if (c.correct) div.style.background = "yellow";
    div.onclick = () => {
      if (!locked) submitAnswer(c.number);
    };
    cardsDiv.appendChild(div);
  });

  state.misclicks.forEach(m => {
    const card = [...document.querySelectorAll("#cards div")].find(d => d.innerText.includes(m.number));
    if (card) {
      card.style.background = "#fdd";
      const tag = document.createElement("div");
      tag.style.color = "red";
      tag.textContent = `お手つき: ${m.name}`;
      card.appendChild(tag);
    }
  });
}

function showYomifudaAnimated(text) {
  if (yomifudaAnimating) return;
  yomifudaAnimating = true;

  const div = document.getElementById("yomifuda");
  div.textContent = "";
  let i = 0;

  const interval = setInterval(() => {
    if (i >= text.length) {
      clearInterval(interval);
      yomifudaAnimating = false;
      socket.emit("read_done", groupId);
      return;
    }
    div.textContent += text.slice(i, i + 5);
    i += 5;
  }, showSpeed);
}

function submitAnswer(number) {
  if (!locked && playerName) {
    socket.emit("answer", { groupId, name: playerName, number });
  }
}

function getMyHP(players) {
  const me = players.find(p => p.name === playerName);
  return me ? me.hp : 20;
}

window.onload = () => {
  showGroupSelectUI();
};
