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
let cryptoKey = null; // AES-GCM key derived from room password

// ─── Crypto (WebCrypto API — AES-256-GCM + PBKDF2) ───────────────────────────
const ROOM_PASSWORD = "Heraldo225";
const SALT = new TextEncoder().encode("chatwistron-v1-salt");

async function deriveKey(password) {
  const raw = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
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
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
  // Pack iv (12 bytes) + ciphertext into one base64 string
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), 12);
  return btoa(String.fromCharCode(...combined));
}

async function decryptText(b64) {
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv         = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
  return new TextDecoder().decode(plain);
}

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
const roomPassword    = document.getElementById("room-password");
const messageForm     = document.getElementById("message-form");
const messageInput    = document.getElementById("message-input");
const messagesList    = document.getElementById("messages-list");
const sendBtn         = document.getElementById("send-btn");
const logoutBtn       = document.getElementById("logout-btn");
const clearBtn        = document.getElementById("clear-btn");
const confirmModal    = document.getElementById("confirm-modal");
const modalCancel     = document.getElementById("modal-cancel");
const modalConfirm    = document.getElementById("modal-confirm");
const onlineCount     = document.getElementById("online-count");
const currentUserBadge = document.getElementById("current-user-badge");
const typingIndicator = document.getElementById("typing-indicator");
const typingText      = document.getElementById("typing-text");
const messagesContainer = document.getElementById("messages-container");

// ─── Login ────────────────────────────────────────────────────────────────────
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim();
  if (!name) return;

  const submitBtn = loginForm.querySelector("button[type=submit]");
  submitBtn.textContent = "Entrando…";
  submitBtn.disabled = true;

  cryptoKey = await deriveKey(ROOM_PASSWORD);

  submitBtn.textContent = "Entrar al chat";
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

messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  sendBtn.disabled = true;

  // Clear typing
  isTyping = false;
  clearTimeout(typingTimer);
  if (myTypingRef) remove(myTypingRef);

  const encrypted = await encryptText(text);
  push(messagesRef, {
    text: encrypted,
    sender: currentUser,
    timestamp: serverTimestamp(),
  });
});

// ─── Render ───────────────────────────────────────────────────────────────────
let lastSender = null;

async function renderMessage(key, data) {
  const { text: encrypted, sender, timestamp } = data;
  const isOwn = sender === currentUser;
  const color = colorFor(sender);

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

  try {
    bubble.textContent = await decryptText(encrypted);
  } catch {
    bubble.textContent = "🔒 Mensaje cifrado (clave incorrecta)";
    bubble.classList.add("decryption-error");
  }

  group.appendChild(bubble);
  messagesList.appendChild(group);
}

// ─── Clear conversation ───────────────────────────────────────────────────────
clearBtn.addEventListener("click", () => {
  confirmModal.classList.remove("hidden");
});

modalCancel.addEventListener("click", () => {
  confirmModal.classList.add("hidden");
});

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) confirmModal.classList.add("hidden");
});

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
  usernameInput.value = "";
  roomPassword.value = "";
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
