import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase,
  ref,
  push,
  onChildAdded,
  onValue,
  set,
  remove,
  serverTimestamp,
  query,
  limitToLast,
  orderByChild,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyDIikasztzAV4Ey-TjLrLcSwjcoZr-sY3s",
  authDomain: "chatw-da95f.firebaseapp.com",
  databaseURL: "https://chatw-da95f-default-rtdb.firebaseio.com",
  projectId: "chatw-da95f",
  storageBucket: "chatw-da95f.firebasestorage.app",
  messagingSenderId: "1042099668915",
  appId: "1:1042099668915:web:6c49d4efaa7ea0b3f6edc6",
};

// ─── Init ─────────────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ─── Refs ─────────────────────────────────────────────────────────────────────
const messagesRef = ref(db, "messages");
const presenceRef = ref(db, "presence");
const typingRef   = ref(db, "typing");

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser = null;
let myPresenceRef = null;
let myTypingRef   = null;
let typingTimer   = null;
let isTyping      = false;
let loadedMessages = new Set();

// ─── Palette for usernames ────────────────────────────────────────────────────
const COLORS = [
  "#6C63FF","#FF6584","#43C6AC","#F7971E","#E040FB",
  "#00BCD4","#FF5722","#4CAF50","#2196F3","#FF9800",
];
const userColors = {};
function colorFor(name) {
  if (!userColors[name]) {
    const idx = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length;
    userColors[name] = COLORS[idx];
  }
  return userColors[name];
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
const loginScreen     = document.getElementById("login-screen");
const chatScreen      = document.getElementById("chat-screen");
const loginForm       = document.getElementById("login-form");
const usernameInput   = document.getElementById("username-input");
const messageForm     = document.getElementById("message-form");
const messageInput    = document.getElementById("message-input");
const messagesList    = document.getElementById("messages-list");
const sendBtn         = document.getElementById("send-btn");
const logoutBtn       = document.getElementById("logout-btn");
const onlineCount     = document.getElementById("online-count");
const currentUserBadge = document.getElementById("current-user-badge");
const typingIndicator = document.getElementById("typing-indicator");
const typingText      = document.getElementById("typing-text");
const messagesContainer = document.getElementById("messages-container");

// ─── Login ────────────────────────────────────────────────────────────────────
loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  if (!name) return;
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
  listenOnlineCount();
  listenTyping();
}

// ─── Presence ─────────────────────────────────────────────────────────────────
function registerPresence() {
  myPresenceRef = ref(db, `presence/${sanitizeKey(currentUser)}`);
  set(myPresenceRef, { name: currentUser, online: true, joinedAt: serverTimestamp() });

  // Remove presence on disconnect (Firebase handles this server-side)
  const connRef = ref(db, ".info/connected");
  onValue(connRef, (snap) => {
    if (snap.val()) {
      // onDisconnect().remove() needs the compat SDK or REST; we handle via beforeunload
    }
  });

  window.addEventListener("beforeunload", leaveChat);
}

function leaveChat() {
  if (myPresenceRef) remove(myPresenceRef);
  if (myTypingRef)   remove(myTypingRef);
}

// ─── Online count ─────────────────────────────────────────────────────────────
function listenOnlineCount() {
  onValue(presenceRef, (snap) => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    onlineCount.textContent = `${count} en línea`;
  });
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
function listenTyping() {
  onValue(typingRef, (snap) => {
    if (!snap.exists()) {
      typingIndicator.classList.add("hidden");
      return;
    }
    const typers = Object.values(snap.val())
      .filter((t) => t.name !== currentUser)
      .map((t) => t.name);

    if (typers.length === 0) {
      typingIndicator.classList.add("hidden");
    } else {
      const label = typers.length === 1
        ? `${typers[0]} está escribiendo…`
        : `${typers.slice(0, -1).join(", ")} y ${typers.at(-1)} están escribiendo…`;
      typingText.textContent = label;
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
}

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  sendBtn.disabled = true;

  // Clear typing
  isTyping = false;
  clearTimeout(typingTimer);
  if (myTypingRef) remove(myTypingRef);

  push(messagesRef, {
    text,
    sender: currentUser,
    timestamp: serverTimestamp(),
  });
});

// ─── Render ───────────────────────────────────────────────────────────────────
let lastSender = null;

function renderMessage(key, data) {
  const { text, sender, timestamp } = data;
  const isOwn = sender === currentUser;
  const color = colorFor(sender);

  // Group consecutive messages from the same sender
  const showMeta = sender !== lastSender;
  lastSender = sender;

  const group = document.createElement("div");
  group.className = `msg-group ${isOwn ? "outgoing" : "incoming"}`;
  group.dataset.key = key;

  if (showMeta) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.innerHTML = `
      <span class="username" style="--user-color:${color}">${escapeHtml(sender)}</span>
      <span class="timestamp">${formatTime(timestamp)}</span>
    `;
    group.appendChild(meta);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  group.appendChild(bubble);

  messagesList.appendChild(group);
}

// ─── Logout ───────────────────────────────────────────────────────────────────
logoutBtn.addEventListener("click", () => {
  leaveChat();
  currentUser = null;
  lastSender = null;
  loadedMessages.clear();
  messagesList.innerHTML = "";
  usernameInput.value = "";
  chatScreen.classList.remove("active");
  loginScreen.classList.add("active");
  usernameInput.focus();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeKey(name) {
  // Firebase keys can't have . # $ [ ] /
  return name.replace(/[.#$[\]/]/g, "_");
}
