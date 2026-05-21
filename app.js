import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onChildAdded,
  onChildRemoved,
  onValue,
  set,
  update,
  remove,
  onDisconnect,
  serverTimestamp,
  query,
  limitToLast,
  orderByChild,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyDIikasztzAV4Ey-TjLrLcSwjcoZr-sY3s",
  authDomain: "chatw-da95f.firebaseapp.com",
  databaseURL: "https://chatw-da95f-default-rtdb.firebaseio.com",
  projectId: "chatw-da95f",
  storageBucket: "chatw-da95f.firebasestorage.app",
  messagingSenderId: "1042099668915",
  appId: "1:1042099668915:web:6c49d4efaa7ea0b3f6edc6",
};

const app = initializeApp(firebaseConfig);
const db  = getDatabase(app);
const storage = getStorage(app);

// ─── Refs ─────────────────────────────────────────────────────────────────────
const messagesRef = ref(db, "messages");
const presenceRef = ref(db, "presence");
const typingRef   = ref(db, "typing");

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser    = null;
let myPresenceRef  = null;
let myTypingRef    = null;
let typingTimer    = null;
let isTyping       = false;
let loadedMessages = new Set();
let cryptoKey      = null;
let replyState     = null; // { key, sender, preview }
let editingNoteKey = null;
let calYear        = new Date().getFullYear();
let calMonth       = new Date().getMonth();
let allTasks       = {};   // local cache of tasks

// ─── Crypto ───────────────────────────────────────────────────────────────────
const ROOM_PASSWORD = "Heraldo225";
const SALT = new TextEncoder().encode("chatwistron-v1-salt");

async function deriveKey(password) {
  const raw = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: SALT, iterations: 200_000, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(12 + ct.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ct), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptText(b64) {
  const combined  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const iv        = combined.slice(0, 12);
  const ct        = combined.slice(12);
  const plain     = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new TextDecoder().decode(plain);
}

// ─── Colors ───────────────────────────────────────────────────────────────────
const COLORS = ["#6C63FF","#FF6584","#43C6AC","#F7971E","#E040FB","#00BCD4","#FF5722","#4CAF50","#2196F3","#FF9800"];
const userColors = {};
function colorFor(name) {
  if (!userColors[name]) {
    const idx = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length;
    userColors[name] = COLORS[idx];
  }
  return userColors[name];
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const loginScreen      = document.getElementById("login-screen");
const chatScreen       = document.getElementById("chat-screen");
const loginForm        = document.getElementById("login-form");
const usernameInput    = document.getElementById("username-input");
const roomPasswordEl   = document.getElementById("room-password");
const loginError       = document.getElementById("login-error");
const messageForm      = document.getElementById("message-form");
const messageInput     = document.getElementById("message-input");
const messagesList     = document.getElementById("messages-list");
const sendBtn          = document.getElementById("send-btn");
const logoutBtn        = document.getElementById("logout-btn");
const clearBtn         = document.getElementById("clear-btn");
const confirmModal     = document.getElementById("confirm-modal");
const modalCancel      = document.getElementById("modal-cancel");
const modalConfirm     = document.getElementById("modal-confirm");
const onlineCount      = document.getElementById("online-count");
const currentUserBadge = document.getElementById("current-user-badge");
const typingIndicator  = document.getElementById("typing-indicator");
const typingText       = document.getElementById("typing-text");
const messagesContainer= document.getElementById("messages-container");
const darkModeBtn      = document.getElementById("dark-mode-btn");
const sidePanelArea    = document.getElementById("side-panel-area");
const fileInput        = document.getElementById("file-input");
const replyBar         = document.getElementById("reply-bar");
const replyToName      = document.getElementById("reply-to-name");
const replyToPreview   = document.getElementById("reply-to-preview");
const replyCancelBtn   = document.getElementById("reply-cancel-btn");
const noteModal        = document.getElementById("note-modal");
const noteTitleInput   = document.getElementById("note-title-input");
const noteBodyInput    = document.getElementById("note-body-input");
const noteSaveBtn      = document.getElementById("note-save-btn");
const noteDeleteBtn    = document.getElementById("note-delete-btn");
const noteCloseBtn     = document.getElementById("note-close-btn");

// ─── Dark Mode ────────────────────────────────────────────────────────────────
function applyTheme(dark) {
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  darkModeBtn.textContent = dark ? "☀️" : "🌙";
}

darkModeBtn.addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  applyTheme(!isDark);
  localStorage.setItem("cw-dark", !isDark ? "1" : "0");
});

applyTheme(localStorage.getItem("cw-dark") === "1");

// ─── Panel management ─────────────────────────────────────────────────────────
const PANELS = {
  "online-panel":   document.getElementById("online-panel"),
  "notes-panel":    document.getElementById("notes-panel"),
  "tasks-panel":    document.getElementById("tasks-panel"),
  "calendar-panel": document.getElementById("calendar-panel"),
};
const PANEL_BTNS = {
  "online-panel":   document.getElementById("online-users-btn"),
  "notes-panel":    document.getElementById("notes-btn"),
  "tasks-panel":    document.getElementById("tasks-btn"),
  "calendar-panel": document.getElementById("calendar-btn"),
};

let activePanel = null;

function openPanel(id) {
  Object.values(PANELS).forEach(p => p.classList.add("hidden"));
  Object.values(PANEL_BTNS).forEach(b => b.classList.remove("active"));

  if (activePanel === id) {
    sidePanelArea.classList.add("hidden");
    activePanel = null;
    return;
  }

  PANELS[id].classList.remove("hidden");
  PANEL_BTNS[id].classList.add("active");
  sidePanelArea.classList.remove("hidden");
  activePanel = id;

  if (id === "calendar-panel") renderCalendar();
}

document.getElementById("online-users-btn").addEventListener("click", () => openPanel("online-panel"));
document.getElementById("notes-btn").addEventListener("click", () => openPanel("notes-panel"));
document.getElementById("tasks-btn").addEventListener("click", () => openPanel("tasks-panel"));
document.getElementById("calendar-btn").addEventListener("click", () => openPanel("calendar-panel"));

document.querySelectorAll(".panel-close").forEach(btn => {
  btn.addEventListener("click", () => {
    sidePanelArea.classList.add("hidden");
    Object.values(PANEL_BTNS).forEach(b => b.classList.remove("active"));
    activePanel = null;
  });
});

// ─── Login ────────────────────────────────────────────────────────────────────
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  const pass = roomPasswordEl.value;
  if (!name || !pass) return;

  if (pass !== ROOM_PASSWORD) {
    loginError.classList.remove("hidden");
    roomPasswordEl.value = "";
    roomPasswordEl.focus();
    return;
  }
  loginError.classList.add("hidden");

  const submitBtn = loginForm.querySelector("button[type=submit]");
  submitBtn.textContent = "Entrando…";
  submitBtn.disabled = true;

  cryptoKey = await deriveKey(ROOM_PASSWORD);

  submitBtn.textContent = "Acceder";
  submitBtn.disabled = false;

  enterChat(name);
});

function enterChat(name) {
  currentUser = name;
  loginScreen.classList.remove("active");
  chatScreen.classList.add("active");
  currentUserBadge.textContent = `@${name}`;
  messageInput.focus();

  registerPresence();
  listenMessages();
  listenOnlineUsers();
  listenTyping();
  listenTasks();
  listenNotes();
}

// ─── Presence ─────────────────────────────────────────────────────────────────
function registerPresence() {
  myPresenceRef = ref(db, `presence/${sanitizeKey(currentUser)}`);
  set(myPresenceRef, { name: currentUser, online: true, joinedAt: serverTimestamp() });
  // Removes presence on server side when WebSocket drops (covers crash/close without beforeunload)
  onDisconnect(myPresenceRef).remove();
  window.addEventListener("beforeunload", leaveChat);
}

function leaveChat() {
  if (myPresenceRef) remove(myPresenceRef);
  if (myTypingRef)   remove(myTypingRef);
}

// ─── Online Users Panel ───────────────────────────────────────────────────────
const onlineUsersList = document.getElementById("online-users-list");

function listenOnlineUsers() {
  onValue(presenceRef, (snap) => {
    const users = snap.exists() ? Object.values(snap.val()) : [];
    const online = users.filter(u => u.online);
    onlineCount.textContent = `${online.length} en línea`;
    renderOnlineUsers(online);
  });
}

function renderOnlineUsers(users) {
  onlineUsersList.innerHTML = "";
  if (!users.length) {
    onlineUsersList.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);padding:8px 4px">Nadie más en línea</p>';
    return;
  }
  users.forEach(u => {
    const el = document.createElement("div");
    el.className = "online-user-item";
    const color = colorFor(u.name);
    el.innerHTML = `
      <div class="online-avatar" style="background:${color}">${escapeHtml(u.name[0].toUpperCase())}</div>
      <span class="online-user-name">${escapeHtml(u.name)}${u.name === currentUser ? " (tú)" : ""}</span>
      <div class="online-dot"></div>
    `;
    onlineUsersList.appendChild(el);
  });
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
function listenTyping() {
  onValue(typingRef, (snap) => {
    if (!snap.exists()) { typingIndicator.classList.add("hidden"); return; }
    const typers = Object.values(snap.val()).filter(t => t.name !== currentUser).map(t => t.name);
    if (!typers.length) {
      typingIndicator.classList.add("hidden");
    } else {
      typingText.textContent = typers.length === 1
        ? `${typers[0]} está escribiendo…`
        : `${typers.slice(0,-1).join(", ")} y ${typers.at(-1)} están escribiendo…`;
      typingIndicator.classList.remove("hidden");
      scrollToBottom();
    }
  });
}

messageInput.addEventListener("input", () => {
  sendBtn.disabled = messageInput.value.trim() === "";
  if (!isTyping) {
    isTyping = true;
    myTypingRef = ref(db, `typing/${sanitizeKey(currentUser)}`);
    set(myTypingRef, { name: currentUser });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isTyping = false;
    if (myTypingRef) remove(myTypingRef);
  }, 2000);
});

// ─── Messages ─────────────────────────────────────────────────────────────────
function listenMessages() {
  const recentQ = query(messagesRef, orderByChild("timestamp"), limitToLast(100));

  onChildAdded(recentQ, (snap) => {
    if (loadedMessages.has(snap.key)) return;
    loadedMessages.add(snap.key);
    renderMessage(snap.key, snap.val());
    scrollToBottom();
  });

  onChildRemoved(recentQ, (snap) => {
    const el = document.querySelector(`.msg-group[data-key="${snap.key}"]`);
    if (el) el.remove();
    loadedMessages.delete(snap.key);
  });
}

// Send text message
messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  sendBtn.disabled = true;
  isTyping = false;
  clearTimeout(typingTimer);
  if (myTypingRef) remove(myTypingRef);

  const encrypted = await encryptText(text);
  const payload = {
    type: "text",
    text: encrypted,
    sender: currentUser,
    timestamp: serverTimestamp(),
  };

  if (replyState) {
    payload.replyTo = { key: replyState.key, sender: replyState.sender, preview: replyState.preview };
    clearReply();
  }

  push(messagesRef, payload);
});

// ─── File Upload ──────────────────────────────────────────────────────────────
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  fileInput.value = "";

  const isImage = file.type.startsWith("image/");
  const path = `uploads/${Date.now()}_${sanitizeKey(file.name)}`;
  const sRef = storageRef(storage, path);

  // Show progress bar in footer
  const progressWrap = document.createElement("div");
  progressWrap.className = "upload-progress-bar";
  const progressFill = document.createElement("div");
  progressFill.className = "upload-progress-fill";
  progressFill.style.width = "0%";
  progressWrap.appendChild(progressFill);
  document.querySelector(".chat-footer").appendChild(progressWrap);

  const uploadTask = uploadBytesResumable(sRef, file);
  uploadTask.on("state_changed",
    (snap) => {
      const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
      progressFill.style.width = pct + "%";
    },
    () => { progressWrap.remove(); },
    async () => {
      progressWrap.remove();
      const url = await getDownloadURL(uploadTask.snapshot.ref);
      const payload = {
        type: isImage ? "image" : "file",
        fileUrl: url,
        fileName: file.name,
        fileSize: file.size,
        sender: currentUser,
        timestamp: serverTimestamp(),
      };
      if (replyState) {
        payload.replyTo = { key: replyState.key, sender: replyState.sender, preview: replyState.preview };
        clearReply();
      }
      push(messagesRef, payload);
    }
  );
});

// ─── Reply ────────────────────────────────────────────────────────────────────
function setReply(key, sender, preview) {
  replyState = { key, sender, preview };
  replyToName.textContent = sender;
  replyToPreview.textContent = preview;
  replyBar.classList.remove("hidden");
  messageInput.focus();
}

function clearReply() {
  replyState = null;
  replyBar.classList.add("hidden");
}

replyCancelBtn.addEventListener("click", clearReply);

// ─── Render message ───────────────────────────────────────────────────────────
let lastSender = null;

async function renderMessage(key, data) {
  const { sender, timestamp, type = "text", replyTo } = data;
  const isOwn  = sender === currentUser;
  const color  = colorFor(sender);
  const showMeta = sender !== lastSender;
  lastSender = sender;

  const group = document.createElement("div");
  group.className = `msg-group ${isOwn ? "outgoing" : "incoming"}`;
  group.dataset.key = key;

  // Meta (username + timestamp)
  if (showMeta) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.innerHTML = `
      <span class="username" style="--user-color:${color}">${escapeHtml(sender)}</span>
      <span class="timestamp">${formatTime(timestamp)}</span>
    `;
    group.appendChild(meta);
  }

  // Reply quote
  if (replyTo) {
    const quote = document.createElement("div");
    quote.className = "reply-quote";
    quote.innerHTML = `
      <div class="reply-quote-sender">${escapeHtml(replyTo.sender)}</div>
      <div class="reply-quote-text">${escapeHtml(replyTo.preview || "")}</div>
    `;
    group.appendChild(quote);
  }

  // Bubble content
  if (type === "image") {
    const imgWrap = document.createElement("a");
    imgWrap.className = "img-bubble";
    imgWrap.href = data.fileUrl;
    imgWrap.target = "_blank";
    imgWrap.rel = "noopener";
    const img = document.createElement("img");
    img.src = data.fileUrl;
    img.alt = data.fileName || "imagen";
    img.loading = "lazy";
    imgWrap.appendChild(img);
    group.appendChild(imgWrap);
  } else if (type === "file") {
    const fileEl = document.createElement("a");
    fileEl.className = "file-bubble";
    fileEl.href = data.fileUrl;
    fileEl.target = "_blank";
    fileEl.rel = "noopener";
    fileEl.innerHTML = `
      <span class="file-icon">${fileIcon(data.fileName)}</span>
      <div class="file-info">
        <div class="file-name">${escapeHtml(data.fileName || "archivo")}</div>
        <div class="file-size">${formatBytes(data.fileSize)}</div>
      </div>
    `;
    group.appendChild(fileEl);
  } else {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    try {
      bubble.textContent = await decryptText(data.text);
    } catch {
      bubble.textContent = "🔒 Mensaje cifrado";
      bubble.classList.add("decryption-error");
    }
    group.appendChild(bubble);
  }

  // Actions (reply + delete)
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  const replyBtn = document.createElement("button");
  replyBtn.className = "msg-action-btn";
  replyBtn.textContent = "↩ Responder";
  replyBtn.addEventListener("click", () => {
    const previewText = type === "text"
      ? (group.querySelector(".bubble")?.textContent || "")
      : type === "image" ? "📷 Imagen" : `📎 ${data.fileName}`;
    setReply(key, sender, previewText.slice(0, 60));
  });
  actions.appendChild(replyBtn);

  if (isOwn) {
    const delBtn = document.createElement("button");
    delBtn.className = "msg-action-btn delete-btn";
    delBtn.textContent = "🗑 Borrar";
    delBtn.addEventListener("click", () => {
      remove(ref(db, `messages/${key}`));
    });
    actions.appendChild(delBtn);
  }

  group.appendChild(actions);
  messagesList.appendChild(group);
}

// ─── Clear conversation ───────────────────────────────────────────────────────
clearBtn.addEventListener("click", () => confirmModal.classList.remove("hidden"));
modalCancel.addEventListener("click", () => confirmModal.classList.add("hidden"));
confirmModal.addEventListener("click", e => { if (e.target === confirmModal) confirmModal.classList.add("hidden"); });
modalConfirm.addEventListener("click", async () => {
  confirmModal.classList.add("hidden");
  await remove(messagesRef);
  messagesList.innerHTML = "";
  loadedMessages.clear();
  lastSender = null;
});

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn.addEventListener("click", () => {
  leaveChat();
  currentUser = null;
  cryptoKey = null;
  lastSender = null;
  loadedMessages.clear();
  messagesList.innerHTML = "";
  clearReply();
  usernameInput.value = "";
  roomPasswordEl.value = "";
  chatScreen.classList.remove("active");
  loginScreen.classList.add("active");
  usernameInput.focus();
});

// ─── Notes ────────────────────────────────────────────────────────────────────
function notesRef() {
  return ref(db, `notes/${sanitizeKey(currentUser)}`);
}

function listenNotes() {
  onValue(notesRef(), (snap) => {
    const notesList = document.getElementById("notes-list");
    notesList.innerHTML = "";
    if (!snap.exists()) return;
    const notes = snap.val();
    Object.entries(notes)
      .sort(([,a],[,b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .forEach(([key, note]) => {
        const el = document.createElement("div");
        el.className = "note-item";
        el.innerHTML = `
          <div class="note-item-title">${escapeHtml(note.title || "Sin título")}</div>
          <div class="note-item-preview">${escapeHtml(note.body || "").slice(0, 80)}</div>
          <div class="note-item-date">${note.updatedAt ? new Date(note.updatedAt).toLocaleDateString("es") : ""}</div>
        `;
        el.addEventListener("click", () => openNote(key, note));
        notesList.appendChild(el);
      });
  });
}

document.getElementById("new-note-btn").addEventListener("click", () => openNote(null, { title: "", body: "" }));

function openNote(key, note) {
  editingNoteKey = key;
  noteTitleInput.value = note.title || "";
  noteBodyInput.value  = note.body  || "";
  noteModal.classList.remove("hidden");
  noteTitleInput.focus();
  noteDeleteBtn.style.display = key ? "flex" : "none";
}

noteSaveBtn.addEventListener("click", async () => {
  const title = noteTitleInput.value.trim() || "Sin título";
  const body  = noteBodyInput.value;
  const data  = { title, body, updatedAt: Date.now() };

  if (editingNoteKey) {
    await update(ref(db, `notes/${sanitizeKey(currentUser)}/${editingNoteKey}`), data);
  } else {
    await push(notesRef(), data);
  }
  noteModal.classList.add("hidden");
});

noteDeleteBtn.addEventListener("click", async () => {
  if (editingNoteKey) {
    await remove(ref(db, `notes/${sanitizeKey(currentUser)}/${editingNoteKey}`));
  }
  noteModal.classList.add("hidden");
});

noteCloseBtn.addEventListener("click", () => noteModal.classList.add("hidden"));
noteModal.addEventListener("click", e => { if (e.target === noteModal) noteModal.classList.add("hidden"); });

// ─── Tasks ────────────────────────────────────────────────────────────────────
function tasksRef() {
  return ref(db, `tasks/${sanitizeKey(currentUser)}`);
}

function listenTasks() {
  onValue(tasksRef(), (snap) => {
    allTasks = snap.exists() ? snap.val() : {};
    renderTasksList();
    if (activePanel === "calendar-panel") renderCalendar();
  });
}

document.getElementById("new-task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title    = document.getElementById("task-input").value.trim();
  const desc     = document.getElementById("task-desc-input").value.trim();
  const assignee = document.getElementById("task-assignee-input").value.trim();
  const goal     = document.getElementById("task-goal-input").value.trim();
  const date     = document.getElementById("task-date").value;
  if (!title) return;
  await push(tasksRef(), {
    title,
    description: desc     || null,
    assignee:    assignee || null,
    goal:        goal     || null,
    dueDate:     date     || null,
    completed:   false,
    createdAt:   Date.now(),
  });
  document.getElementById("task-input").value          = "";
  document.getElementById("task-desc-input").value     = "";
  document.getElementById("task-assignee-input").value = "";
  document.getElementById("task-goal-input").value     = "";
  document.getElementById("task-date").value           = "";
});

function renderTasksList() {
  const list = document.getElementById("tasks-list");
  list.innerHTML = "";
  const entries = Object.entries(allTasks).sort(([,a],[,b]) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!entries.length) {
    list.innerHTML = '<p style="font-size:0.8rem;color:var(--text-muted);padding:4px">Sin tareas. ¡Agrega una!</p>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  entries.forEach(([key, task]) => {
    const el = document.createElement("div");
    el.className = `task-item${task.completed ? " done" : ""}`;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "task-check";
    check.checked = !!task.completed;
    check.addEventListener("change", () => {
      update(ref(db, `tasks/${sanitizeKey(currentUser)}/${key}`), { completed: check.checked });
    });

    const info = document.createElement("div");
    info.className = "task-info";

    const titleEl = document.createElement("div");
    titleEl.className = "task-title";
    titleEl.textContent = task.title;
    info.appendChild(titleEl);

    if (task.assignee) {
      const assigneeEl = document.createElement("div");
      assigneeEl.className = "task-meta-row";
      assigneeEl.textContent = `👤 ${task.assignee}`;
      info.appendChild(assigneeEl);
    }

    if (task.goal) {
      const goalEl = document.createElement("div");
      goalEl.className = "task-meta-row task-goal";
      goalEl.textContent = `🎯 ${task.goal}`;
      info.appendChild(goalEl);
    }

    if (task.description) {
      const descEl = document.createElement("div");
      descEl.className = "task-desc";
      descEl.textContent = task.description;
      info.appendChild(descEl);
    }

    if (task.dueDate) {
      const isOverdue = !task.completed && task.dueDate < today;
      const dateEl = document.createElement("div");
      dateEl.className = `task-date${isOverdue ? " overdue" : ""}`;
      dateEl.textContent = `📅 ${formatDateLabel(task.dueDate)}${isOverdue ? " · Vencida" : ""}`;
      info.appendChild(dateEl);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "task-delete-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Eliminar tarea";
    delBtn.addEventListener("click", () => remove(ref(db, `tasks/${sanitizeKey(currentUser)}/${key}`)));

    el.appendChild(check);
    el.appendChild(info);
    el.appendChild(delBtn);
    list.appendChild(el);
  });
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
const calGrid      = document.getElementById("calendar-grid");
const calLabel     = document.getElementById("cal-month-label");
const calDayTasks  = document.getElementById("cal-day-tasks");
const calDayTitle  = document.getElementById("cal-day-title");
const calDayList   = document.getElementById("cal-day-list");

document.getElementById("cal-prev").addEventListener("click", () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
document.getElementById("cal-next").addEventListener("click", () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});

function renderCalendar() {
  calGrid.innerHTML = "";

  const MONTH_NAMES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const DAY_NAMES   = ["Lu","Ma","Mi","Ju","Vi","Sa","Do"];

  calLabel.textContent = `${MONTH_NAMES[calMonth]} ${calYear}`;

  // Day headers
  DAY_NAMES.forEach(d => {
    const h = document.createElement("div");
    h.className = "cal-day-name";
    h.textContent = d;
    calGrid.appendChild(h);
  });

  // Days with tasks
  const taskDates = new Set(Object.values(allTasks).filter(t => t.dueDate).map(t => t.dueDate));

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const firstDay = new Date(calYear, calMonth, 1);
  const lastDay  = new Date(calYear, calMonth + 1, 0);
  // Adjust: Monday = 0
  let startDow = (firstDay.getDay() + 6) % 7;

  // Padding cells
  for (let i = 0; i < startDow; i++) {
    const empty = document.createElement("div");
    empty.className = "cal-day empty other-month";
    calGrid.appendChild(empty);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dateStr = `${calYear}-${String(calMonth+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const dayEl = document.createElement("div");
    dayEl.className = "cal-day";
    if (dateStr === todayStr) dayEl.classList.add("today");
    if (taskDates.has(dateStr)) dayEl.classList.add("has-tasks");
    dayEl.textContent = d;
    dayEl.addEventListener("click", () => showDayTasks(dateStr, d));
    calGrid.appendChild(dayEl);
  }
}

function showDayTasks(dateStr, day) {
  document.querySelectorAll(".cal-day.selected").forEach(el => el.classList.remove("selected"));
  const dayEl = [...document.querySelectorAll(".cal-day")].find(el => el.textContent == day && !el.classList.contains("other-month"));
  if (dayEl) dayEl.classList.add("selected");

  const MONTH_NAMES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  calDayTitle.textContent = `${day} de ${MONTH_NAMES[calMonth]} de ${calYear}`;

  const dayTasks = Object.entries(allTasks).filter(([,t]) => t.dueDate === dateStr);
  calDayList.innerHTML = "";

  if (!dayTasks.length) {
    calDayList.innerHTML = '<div class="cal-empty">Sin tareas este día.</div>';
  } else {
    dayTasks.forEach(([,task]) => {
      const el = document.createElement("div");
      el.className = `cal-task-item${task.completed ? " done" : ""}`;
      el.textContent = task.title;
      calDayList.appendChild(el);
    });
  }
  calDayTasks.classList.remove("hidden");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => { messagesContainer.scrollTop = messagesContainer.scrollHeight; });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(str) {
  if (!str) return "";
  const [y, m, d] = str.split("-");
  return `${d}/${m}/${y}`;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

function fileIcon(name) {
  if (!name) return "📎";
  const ext = name.split(".").pop().toLowerCase();
  const map = { pdf:"📄", doc:"📝", docx:"📝", xls:"📊", xlsx:"📊", zip:"🗜️", txt:"📄", mp4:"🎥", mov:"🎥" };
  return map[ext] || "📎";
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function sanitizeKey(name) {
  return name.replace(/[.#$[\]/]/g, "_");
}
