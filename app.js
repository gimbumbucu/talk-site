/**
 * 실시간 채팅 & 전화 (WebRTC) & 무음 알림 & 사진 전송 & 로컬 PC 저장 클라이언트 로직
 * (김범서 & 조민아 전용 보안 로그인 시스템 - GitHub Pages 고정 도메인 지원)
 */

// ==================== 서버 연결 주소 자동 확인 및 소켓 초기화 ====================
let SERVER_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? window.location.origin
  : (localStorage.getItem('cached_server_url') || '');

function getFullUrl(path) {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('blob:') || path.startsWith('data:')) {
    return path;
  }
  const base = SERVER_URL || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? window.location.origin : '');
  return base ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : path;
}

const socket = io(SERVER_URL || undefined, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000
});

// KVDB에서 최신 서버 주소 가져와 백엔드 통신 대상 실시간 동기화
async function checkAndSyncServerUrl() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return;
  try {
    const res = await fetch('https://kvdb.io/2DZmKeioXVnwvtF7hLgkaN/current_url?nocache=' + Date.now());
    if (res.ok) {
      const latestUrl = (await res.text()).trim();
      if (latestUrl && latestUrl.startsWith('http')) {
        localStorage.setItem('cached_server_url', latestUrl);
        if (latestUrl !== SERVER_URL) {
          console.log('[KVDB] 새 서버 주소 감지:', latestUrl);
          SERVER_URL = latestUrl;
          if (socket) {
            socket.io.uri = latestUrl;
            if (!socket.connected) {
              socket.connect();
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[KVDB] 서버 주소 조회 실패:', e);
  }
}
checkAndSyncServerUrl();

// ==================== 서버 연결 끊김 시 백그라운드 자동 복구 (페이지 이동/새로고침 없이 유지) ====================
let domainWatchInterval = null;

socket.on('disconnect', (reason) => {
  console.log('[Socket Disconnected]', reason);
  if (domainWatchInterval) clearInterval(domainWatchInterval);

  showToast({
    title: '🔄 서버 연결 대기 중...',
    body: 'PC에서 서버가 켜지면 0.1초 만에 자동으로 연결됩니다.',
    isSilent: true
  });

  // KVDB를 2초 간격으로 확인하여 서버가 켜지면 소켓만 자동 재연결 (도메인은 gimbumbucu.github.io에 100% 고정)
  domainWatchInterval = setInterval(async () => {
    try {
      const res = await fetch('https://kvdb.io/2DZmKeioXVnwvtF7hLgkaN/current_url?nocache=' + Date.now());
      if (res.ok) {
        const latestUrl = (await res.text()).trim();
        if (latestUrl && latestUrl.startsWith('http')) {
          SERVER_URL = latestUrl;
          localStorage.setItem('cached_server_url', latestUrl);
          if (socket.io.uri !== latestUrl) {
            socket.io.uri = latestUrl;
          }
          if (!socket.connected) {
            socket.connect();
          }
        }
      }
    } catch (e) { }
  }, 2000);
});

socket.on('connect', () => {
  if (domainWatchInterval) {
    clearInterval(domainWatchInterval);
    domainWatchInterval = null;
  }
  reportAppVisibility();
});

// ==================== 어플 활성화 상태(보고 있는지 여부) 서버 보고 ====================
function reportAppVisibility() {
  const isVisible = document.visibilityState === 'visible' && (document.hasFocus ? document.hasFocus() : true);
  if (socket && socket.connected) {
    socket.emit('app_visibility', { visible: isVisible });
    // 통화 연결 중이거나 통화 중일 때는 중복 수신 모달 방지를 위해 check_pending_call을 보내지 않음!
    if (isVisible && !isCallConnectingOrActive && !peerConnection) {
      socket.emit('check_pending_call');
    }
  }
}

// 서비스 워커 푸시 알림 클릭 수신 시 대기 중인 전화 즉시 체크
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'NOTIFICATION_CLICKED') {
      if (socket && socket.connected && !isCallConnectingOrActive && !peerConnection) {
        socket.emit('check_pending_call');
      }
    }
  });
}

document.addEventListener('visibilitychange', () => {
  reportAppVisibility();
  if (document.visibilityState === 'visible') {
    scrollToBottom(false);
  }
});
window.addEventListener('focus', () => {
  reportAppVisibility();
  scrollToBottom(false);
});
window.addEventListener('blur', () => {
  if (socket && socket.connected) {
    socket.emit('app_visibility', { visible: false });
  }
});

// ==================== 도메인 변경 시에도 자동 로그인 영구 유지 (Cross-Domain Sync) ====================
function checkAndApplyHashAuth() {
  const hash = window.location.hash;
  if (hash && hash.includes('auth=')) {
    try {
      const match = hash.match(/auth=([^&]+)/);
      if (match && match[1]) {
        const decoded = decodeURIComponent(escape(atob(match[1])));
        const parsed = JSON.parse(decoded);
        if (parsed.username && parsed.password) {
          localStorage.setItem('chat_saved_user', JSON.stringify(parsed));
        }
      }
    } catch (e) {
      console.error('해시 인증 파싱 오류:', e);
    }
    if (window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }
}
checkAndApplyHashAuth();

function syncAuthToGateway(userData) {
  try {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(userData))));
    let syncFrame = document.getElementById('auth-sync-frame');
    if (!syncFrame) {
      syncFrame = document.createElement('iframe');
      syncFrame.id = 'auth-sync-frame';
      syncFrame.style.display = 'none';
      document.body.appendChild(syncFrame);
    }
    syncFrame.src = `https://gimbumbucu.github.io/talk-site/#sync=${b64}`;
  } catch (e) { }
}

function clearAuthFromGateway() {
  try {
    let syncFrame = document.getElementById('auth-sync-frame');
    if (!syncFrame) {
      syncFrame = document.createElement('iframe');
      syncFrame.id = 'auth-sync-frame';
      syncFrame.style.display = 'none';
      document.body.appendChild(syncFrame);
    }
    syncFrame.src = 'https://gimbumbucu.github.io/talk-site/#sync=clear';
  } catch (e) { }
}

let currentUser = null;
let currentRoomId = '김범서--dm--조민아';
let currentRoom = null;
let currentTargetUsername = null; // 1:1 대화 상대 (김범서 또는 조민아)

let editingMessageId = null;
let replyingToMessage = null; // 답장 대상 메시지
let selectedMediaFile = null; // 첨부 사진/동영상 파일
let selectedMediaType = 'image'; // 'image' | 'video'

let isSilentModeEnabled = localStorage.getItem('chat_silent_mode') === 'true';

// 사용자 프로필 캐시 (username -> { username, displayName, avatarUrl, statusMessage, isOnline })
const userProfilesMap = new Map();
let tempProfileAvatarUrl = '';

// WebRTC 관련 상태
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let activeCallTargetSocketId = null;
let activeCallTargetUsername = null;
let activeCallType = null;
let callTimerInterval = null;
let callSeconds = 0;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

// DOM 요소 캐싱
const loginModal = document.getElementById('login-modal');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');
const loginErrorMsg = document.getElementById('login-error-msg');
const btnLogout = document.getElementById('btn-logout');

const mainSidebar = document.getElementById('main-sidebar');
const chatArea = document.getElementById('chat-area');
const btnBackToRooms = document.getElementById('btn-back-to-rooms');

const myUsername = document.getElementById('my-username');
const myStatusText = document.getElementById('my-status-text');
const myAvatarChar = document.getElementById('my-avatar-char');
const myAvatarImg = document.getElementById('my-avatar-img');
const btnOpenProfile = document.getElementById('btn-open-profile');

// 프로필 설정 모달 DOM
const profileModal = document.getElementById('profile-modal');
const btnCloseProfile = document.getElementById('btn-close-profile');
const btnCancelProfile = document.getElementById('btn-cancel-profile');
const profileEditForm = document.getElementById('profile-edit-form');
const inputDisplayName = document.getElementById('input-display-name');
const inputStatusMessage = document.getElementById('input-status-message');
const profileModalAvatarPreview = document.getElementById('profile-modal-avatar-preview');
const profileModalAvatarChar = document.getElementById('profile-modal-avatar-char');
const profileModalAvatarImg = document.getElementById('profile-modal-avatar-img');
const profileAvatarInput = document.getElementById('profile-avatar-input');
const btnResetAvatar = document.getElementById('btn-reset-avatar');
const btnSaveProfile = document.getElementById('btn-save-profile');

// 닉네임 변경 모달 DOM
const btnEditPeerName = document.getElementById('btn-edit-peer-name');
const nicknameModal = document.getElementById('nickname-modal');
const btnCloseNicknameModal = document.getElementById('btn-close-nickname-modal');
const btnCancelNickname = document.getElementById('btn-cancel-nickname');
const formChangeNickname = document.getElementById('form-change-nickname');
const inputNewNickname = document.getElementById('input-new-nickname');
const nicknameModalTitle = document.getElementById('nickname-modal-title');
const nicknameModalLabel = document.getElementById('nickname-modal-label');

const toggleSilentMode = document.getElementById('toggle-silent-mode');
const btnRequestNotification = document.getElementById('btn-request-notification');

// iOS PWA 설치 안내 모달 DOM
const iosPwaModal = document.getElementById('ios-pwa-modal');
const btnCloseIosModal = document.getElementById('btn-close-ios-modal');
const btnConfirmIosModal = document.getElementById('btn-confirm-ios-modal');

// 모바일 기기 감지
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

// 서비스 워커 등록
let swRegistration = null;
async function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    try {
      swRegistration = await navigator.serviceWorker.register('sw.js');
      console.log('[SW] 서비스 워커 등록 완료:', swRegistration.scope);
    } catch (err) {
      console.warn('[SW] 서비스 워커 등록 실패:', err);
    }
  }
}
initServiceWorker();

// 모바일/데스크톱 통합 푸시 알림 발송 헬퍼
async function showNativeNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const notiOptions = {
    icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
    vibrate: options.silent ? [] : [150, 75, 150],
    data: { url: window.location.href },
    ...options
  };

  // 모바일 진동
  if ('vibrate' in navigator && !options.silent) {
    try { navigator.vibrate([150, 75, 150]); } catch (e) { }
  }

  // 1순위: 모바일 백그라운드용 ServiceWorker showNotification (안드로이드 & iOS PWA 필수)
  try {
    const reg = swRegistration || (await navigator.serviceWorker?.getRegistration());
    if (reg && typeof reg.showNotification === 'function') {
      await reg.showNotification(title, notiOptions);
      return;
    }
  } catch (err) {
    console.warn('[SW 알림 실패, 폴백 시도]', err);
  }

  // 2순위: 데스크톱 브라우저용 new Notification
  try {
    new Notification(title, notiOptions);
  } catch (err) {
    console.warn('[브라우저 알림 실패]', err);
  }
}

// VAPID 공개키 Base64 변환 유틸
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// 아이폰/안드로이드 원격 Web Push 구독 (화면 꺼져 있어도 수신 가능하도록 서버에 등록)
async function subscribePushNotification() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Web Push] 이 기기/브라우저는 PushManager를 지원하지 않습니다.');
    return false;
  }
  if (!currentUser) return false;

  try {
    const reg = await navigator.serviceWorker.ready;
    const res = await fetch(getFullUrl('/api/vapid-public-key'));
    const data = await res.json();
    if (!data.success || !data.publicKey) return false;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(data.publicKey)
      });
    }

    // 서버에 구독 저장
    await fetch(getFullUrl('/api/save-subscription'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: currentUser.username,
        subscription: sub
      })
    });

    console.log('[Web Push] 잠금화면 푸시 구독 등록 완료!');
    return true;
  } catch (err) {
    console.warn('[Web Push 구독 오류]:', err);
    return false;
  }
}

const tabRooms = document.getElementById('tab-rooms');
const tabUsers = document.getElementById('tab-users');
const panelRooms = document.getElementById('panel-rooms');
const panelUsers = document.getElementById('panel-users');

const currentRoomTitle = document.getElementById('current-room-title');
const callActionGroup = document.getElementById('call-action-group');
const btnStartVoiceCall = document.getElementById('btn-start-voice-call');
const btnStartVideoCall = document.getElementById('btn-start-video-call');

const messagesContainer = document.getElementById('messages-container');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const toggleSilentSend = document.getElementById('toggle-silent-send');
const editModeIndicator = document.getElementById('edit-mode-indicator');
const btnCancelEdit = document.getElementById('btn-cancel-edit');
const btnSendText = document.getElementById('btn-send-text');

// 미디어 첨부 & 플러스 메뉴 DOM
const btnAttachMenu = document.getElementById('btn-attach-menu');
const attachPopupMenu = document.getElementById('attach-popup-menu');
const attachPlusIcon = document.getElementById('attach-plus-icon');
const imageUploadInput = document.getElementById('image-upload-input');
const cameraPhotoInput = document.getElementById('camera-photo-input');
const cameraVideoInput = document.getElementById('camera-video-input');
const imagePreviewBar = document.getElementById('image-preview-bar');
const imagePreviewThumb = document.getElementById('image-preview-thumb');
const videoPreviewIcon = document.getElementById('video-preview-icon');
const imagePreviewName = document.getElementById('image-preview-name');
const imagePreviewSize = document.getElementById('image-preview-size');
const btnRemoveImage = document.getElementById('btn-remove-image');

// 답장 모드 DOM
const replyModeIndicator = document.getElementById('reply-mode-indicator');
const replyTargetName = document.getElementById('reply-target-name');
const replyTargetText = document.getElementById('reply-target-text');
const btnCancelReply = document.getElementById('btn-cancel-reply');

// 인스타그램 스타일 그리기 모달 DOM
const btnOpenDrawModal = document.getElementById('btn-open-draw-modal');
const drawModal = document.getElementById('draw-modal');
const btnCloseDraw = document.getElementById('btn-close-draw');
const btnUndoDraw = document.getElementById('btn-undo-draw');
const btnClearDraw = document.getElementById('btn-clear-draw');
const btnFinishDraw = document.getElementById('btn-finish-draw');
const drawingCanvas = document.getElementById('drawing-canvas');
const drawLineWidth = document.getElementById('draw-line-width');
const btnEraserMode = document.getElementById('btn-eraser-mode');
const eraserBtnText = document.getElementById('eraser-btn-text');
const colorPalette = document.getElementById('color-palette');

// 라이트박스 DOM
const lightboxModal = document.getElementById('lightbox-modal');
const lightboxImg = document.getElementById('lightbox-img');
const btnCloseLightbox = document.getElementById('btn-close-lightbox');
const btnDownloadLightbox = document.getElementById('btn-download-lightbox');

// 통화 관련 DOM
const incomingCallModal = document.getElementById('incoming-call-modal');
const callerNameDisplay = document.getElementById('caller-name-display');
const incomingCallTypeDisplay = document.getElementById('incoming-call-type-display');
const incomingCallIcon = document.getElementById('incoming-call-icon');
const btnAcceptCall = document.getElementById('btn-accept-call');
const btnRejectCall = document.getElementById('btn-reject-call');

const activeCallOverlay = document.getElementById('active-call-overlay');
const activeCallPeerName = document.getElementById('active-call-peer-name');
const activeCallStatus = document.getElementById('active-call-status');
const callTimer = document.getElementById('call-timer');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const localVideoContainer = document.getElementById('local-video-container');
const voiceOnlyAvatar = document.getElementById('voice-only-avatar');
const btnToggleMic = document.getElementById('btn-toggle-mic');
const btnToggleCam = document.getElementById('btn-toggle-cam');
const btnHangup = document.getElementById('btn-hangup');

// 백그라운드 통화 & 최소화 DOM
const btnMinimizeCall = document.getElementById('btn-minimize-call');
const btnPipCall = document.getElementById('btn-pip-call');
const floatingCallBar = document.getElementById('floating-call-bar');
const floatingCallName = document.getElementById('floating-call-name');
const floatingCallTimer = document.getElementById('floating-call-timer');
const btnFloatingHangup = document.getElementById('btn-floating-hangup');
const remoteAudio = document.getElementById('remote-audio');

const toastContainer = document.getElementById('toast-container');
const audioNotification = document.getElementById('audio-notification');
const audioRingtone = document.getElementById('audio-ringtone');

let pendingIncomingCall = null;
let isCallConnectingOrActive = false; // 통화 연결 중 또는 통화 중 상태 플래그
let isRingtonePlaying = false; // 벨소리 재생 상태 플래그

// 실시간 타이핑 인디케이터 상태
let myTypingTimer = null;
let isMyTypingActive = false;
const activeTypingUsers = new Map(); // username -> { username, displayName, avatarUrl }

// ==================== 초기 설정 및 이벤트 리스너 ====================
window.addEventListener('DOMContentLoaded', () => {
  // 모바일 및 브라우저 엔터 전송 시 화면 위아래 반동(바운스) 원천 차단
  messageInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중일 때는 무시
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // submit 이벤트 직접 디스패치
      if (typeof messageForm.requestSubmit === 'function') {
        messageForm.requestSubmit();
      } else {
        messageForm.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    }
  });

  // 실시간 타이핑 감지 (상대방에게 챗 치고 있음을 알림)
  messageInput.addEventListener('input', () => {
    if (messageInput.value.trim().length > 0) {
      startMyTyping();
    } else {
      stopMyTyping();
    }
  });

  messageInput.addEventListener('blur', () => {
    stopMyTyping();
  });

  // 모바일 가상 키보드 팝업 시 입력창 및 대화창 높이 완벽 동기화
  const syncVisualViewport = () => {
    if (window.visualViewport) {
      const vh = window.visualViewport.height;
      document.documentElement.style.setProperty('--visual-height', `${vh}px`);
      // 대화창 최하단으로 즉시 이동하여 최신 대화와 입력창을 키보드 위에 완벽 정렬
      requestAnimationFrame(() => {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      });
    }
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncVisualViewport);
    window.visualViewport.addEventListener('scroll', () => {
      window.scrollTo(0, 0);
    });
  }

  // 모바일 입력창 터치(포커스) 시 키보드가 올라오는 타이밍에 맞춰 대화창과 입력창을 위로 올림
  messageInput.addEventListener('focus', () => {
    setTimeout(syncVisualViewport, 50);
    setTimeout(syncVisualViewport, 200);
    setTimeout(syncVisualViewport, 400);
  });

  messageInput.addEventListener('blur', () => {
    setTimeout(syncVisualViewport, 100);
  });

  syncVisualViewport();

  // 브라우저 윈도우 레벨 스크롤 튐/반동 방지 (오직 messages-container 내부만 스크롤)
  window.addEventListener('scroll', () => {
    if (window.scrollY !== 0 || window.scrollX !== 0) {
      window.scrollTo(0, 0);
    }
  }, { passive: true });

  toggleSilentMode.checked = isSilentModeEnabled;

  toggleSilentMode.addEventListener('change', (e) => {
    isSilentModeEnabled = e.target.checked;
    localStorage.setItem('chat_silent_mode', isSilentModeEnabled);
    showToast({
      title: isSilentModeEnabled ? '🔕 무음 모드 켜짐' : '🔔 무음 모드 꺼짐',
      body: isSilentModeEnabled ? '모든 알림과 벨소리가 소리 없이 무음으로 전달됩니다.' : '알림 소리가 켜졌습니다.',
      isSilent: true
    });
  });

  // 알림 권한 상태 UI 갱신 함수
  function updateNotificationButtonUI() {
    if ('Notification' in window && Notification.permission === 'granted') {
      btnRequestNotification.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-200');
      btnRequestNotification.innerHTML = '<i class="fa-solid fa-bell text-emerald-600"></i><span class="hidden sm:inline ml-1">알림 켜짐</span>';
    }
  }
  updateNotificationButtonUI();

  btnRequestNotification.addEventListener('click', async () => {
    // 1. 아이폰/아이패드 사파리 일반 탭인 경우 -> 홈 화면 추가 가이드 모달 띄우기
    if (isIOS && !isStandalone) {
      iosPwaModal.classList.remove('hidden');
      return;
    }

    // 2. Notification 지원 여부 확인
    if (!('Notification' in window)) {
      if (isIOS) {
        iosPwaModal.classList.remove('hidden');
      } else {
        alert('현재 브라우저는 웹 알림을 지원하지 않습니다. 모바일 Chrome 또는 Edge 브라우저를 사용해 주세요.');
      }
      return;
    }

    // 3. 이미 허용되어 있는 경우 -> 원격 푸시 구독 보장 및 테스트 알림 발송
    if (Notification.permission === 'granted') {
      showToast({
        title: '🔔 알림이 켜져 있습니다',
        body: '아이폰/모바일 원격 푸시를 테스트합니다...',
        isSilent: true
      });
      await subscribePushNotification();
      // 서버에서 실제 APNs/FCM 원격 푸시 발송
      fetch(getFullUrl('/api/test-push'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentUser?.username || '김범서' })
      }).catch(() => { });
      return;
    }

    // 4. 모바일 및 데스크톱 알림 권한 요청
    try {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        updateNotificationButtonUI();
        showToast({
          title: '알림 권한 허용됨',
          body: '모바일/아이폰 백그라운드 푸시 알림이 활성화되었습니다.',
          isSilent: true
        });
        await subscribePushNotification();
        // 서버에서 실제 APNs/FCM 원격 푸시 발송
        fetch(getFullUrl('/api/test-push'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: currentUser?.username || '김범서' })
        }).catch(() => { });
      } else if (perm === 'denied') {
        alert('알림 권한이 차단되어 있습니다. 스마트폰 설정 > Safari/Chrome > 알림에서 허용해 주세요.');
      }
    } catch (err) {
      console.error('알림 권한 요청 실패:', err);
    }
  });

  // iOS PWA 모달 닫기
  if (btnCloseIosModal) {
    btnCloseIosModal.addEventListener('click', () => iosPwaModal.classList.add('hidden'));
  }
  if (btnConfirmIosModal) {
    btnConfirmIosModal.addEventListener('click', () => iosPwaModal.classList.add('hidden'));
  }
  if (iosPwaModal) {
    iosPwaModal.addEventListener('click', (e) => {
      if (e.target === iosPwaModal) iosPwaModal.classList.add('hidden');
    });
  }

  // 프로필 설정 모달 이벤트 바인딩
  btnOpenProfile.addEventListener('click', openProfileModal);
  btnCloseProfile.addEventListener('click', closeProfileModal);
  btnCancelProfile.addEventListener('click', closeProfileModal);
  profileModal.addEventListener('click', (e) => {
    if (e.target === profileModal) closeProfileModal();
  });

  profileAvatarInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('image', file);
    try {
      btnSaveProfile.textContent = '업로드 중...';
      const res = await fetch(getFullUrl('/api/upload'), { method: 'POST', body: formData });
      const data = await res.json();
      btnSaveProfile.textContent = '저장';
      if (data.success) {
        tempProfileAvatarUrl = data.fileUrl;
        updateProfileModalPreview(tempProfileAvatarUrl, inputDisplayName.value);
      } else {
        alert('사진 업로드 실패: ' + data.message);
      }
    } catch (err) {
      btnSaveProfile.textContent = '저장';
      alert('사진 업로드 중 오류가 발생했습니다.');
    }
    profileAvatarInput.value = '';
  });

  btnResetAvatar.addEventListener('click', () => {
    tempProfileAvatarUrl = '';
    updateProfileModalPreview('', inputDisplayName.value);
  });

  document.querySelectorAll('.preset-emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      tempProfileAvatarUrl = btn.dataset.emoji;
      updateProfileModalPreview(tempProfileAvatarUrl, inputDisplayName.value);
    });
  });

  inputDisplayName.addEventListener('input', () => {
    if (!tempProfileAvatarUrl) {
      updateProfileModalPreview('', inputDisplayName.value);
    }
  });

  profileEditForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const newName = inputDisplayName.value.trim();
    const newStatus = inputStatusMessage.value.trim();
    if (!newName) {
      alert('이름(닉네임)을 입력해주세요.');
      return;
    }
    btnSaveProfile.textContent = '저장 중...';
    socket.emit('update_profile', {
      displayName: newName,
      avatarUrl: tempProfileAvatarUrl,
      statusMessage: newStatus,
      roomId: currentRoomId
    }, (res) => {
      btnSaveProfile.textContent = '저장';
      if (res.success) {
        currentUser.displayName = res.user.displayName;
        currentUser.avatarUrl = res.user.avatarUrl;
        currentUser.statusMessage = res.user.statusMessage;
        userProfilesMap.set(currentUser.username, res.user);
        updateMyHeaderProfile();
        closeProfileModal();
        showToast({
          title: '프로필 저장 완료',
          body: '이름과 프로필이 변경되었습니다.',
          isSilent: true
        });
      } else {
        alert(res.message || '저장 실패');
      }
    });
  });

  // 닉네임 변경 모달 바인딩
  function openNicknameModal() {
    if (!currentTargetUsername && currentUser) {
      const partner = currentUser.username === '김범서' ? '조민아' : '김범서';
      currentTargetUsername = partner;
    }
    const targetProfile = userProfilesMap.get(currentTargetUsername);
    const currentName = targetProfile?.displayName || currentTargetUsername || '상대방';

    nicknameModalTitle.textContent = `${currentName} 닉네임 변경`;
    nicknameModalLabel.textContent = `'${currentName}'의 새 닉네임`;
    inputNewNickname.value = currentName;
    nicknameModal.classList.remove('hidden');
    setTimeout(() => {
      inputNewNickname.focus();
      inputNewNickname.select();
    }, 50);
  }

  function closeNicknameModal() {
    nicknameModal.classList.add('hidden');
  }

  btnEditPeerName.addEventListener('click', (e) => {
    e.stopPropagation();
    openNicknameModal();
  });

  btnCloseNicknameModal.addEventListener('click', closeNicknameModal);
  btnCancelNickname.addEventListener('click', closeNicknameModal);

  nicknameModal.addEventListener('click', (e) => {
    if (e.target === nicknameModal) closeNicknameModal();
  });

  formChangeNickname.addEventListener('submit', (e) => {
    e.preventDefault();
    const newName = inputNewNickname.value.trim();
    if (!newName) {
      alert('닉네임을 입력해주세요.');
      return;
    }

    const targetUser = currentTargetUsername || (currentUser ? (currentUser.username === '김범서' ? '조민아' : '김범서') : null);

    socket.emit('change_nickname', {
      targetUsername: targetUser,
      newDisplayName: newName,
      roomId: currentRoomId
    }, (res) => {
      if (res.success) {
        closeNicknameModal();
        showToast({
          title: '닉네임 변경 완료',
          body: `'${newName}'(으)로 닉네임이 변경되었습니다.`,
          isSilent: true
        });
      } else {
        alert(res.message || '닉네임 변경 실패');
      }
    });
  });

  // 로그아웃 버튼
  btnLogout.addEventListener('click', () => {
    if (confirm('로그아웃 하시겠습니까?')) {
      localStorage.removeItem('chat_saved_user');
      clearAuthFromGateway();
      setTimeout(() => {
        location.reload();
      }, 150);
    }
  });

  // 저장된 계정으로 자동 로그인
  const savedUserJson = localStorage.getItem('chat_saved_user');
  if (savedUserJson) {
    try {
      const { username, password } = JSON.parse(savedUserJson);
      if (username && password) {
        performLogin(username, password);
      }
    } catch (e) {
      localStorage.removeItem('chat_saved_user');
    }
  }

  tabRooms.addEventListener('click', () => {
    tabRooms.className = 'flex-1 py-1.5 text-xs font-bold text-blue-600 bg-blue-50 rounded-lg transition';
    tabUsers.className = 'flex-1 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 rounded-lg transition';
    panelRooms.classList.remove('hidden');
    panelUsers.classList.add('hidden');
  });

  tabUsers.addEventListener('click', () => {
    tabUsers.className = 'flex-1 py-1.5 text-xs font-bold text-blue-600 bg-blue-50 rounded-lg transition';
    tabRooms.className = 'flex-1 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 rounded-lg transition';
    panelUsers.classList.remove('hidden');
    panelRooms.classList.add('hidden');
  });

  window.addEventListener('focus', () => {
    if (currentRoomId) {
      socket.emit('mark_read', { roomId: currentRoomId });
    }
  });

  // 클립보드 이미지 붙여넣기 (Ctrl + V)
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          handleImageSelect(file);
          e.preventDefault();
          break;
        }
      }
    }
  });
});

// ==================== 미디어 첨부 (+ 메뉴) & 사진/동영상/그리기 ====================
if (btnAttachMenu) {
  btnAttachMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const isClosed = attachPopupMenu.classList.contains('hidden');
    if (isClosed) {
      attachPopupMenu.classList.remove('hidden');
      attachPlusIcon.classList.add('rotate-45', 'text-rose-500');
    } else {
      closeAttachMenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!attachPopupMenu.contains(e.target) && !btnAttachMenu.contains(e.target)) {
      closeAttachMenu();
    }
  });
}

function closeAttachMenu() {
  if (attachPopupMenu) {
    attachPopupMenu.classList.add('hidden');
  }
  if (attachPlusIcon) {
    attachPlusIcon.classList.remove('rotate-45', 'text-rose-500');
  }
}

// 1. 사진/앨범 선택
if (imageUploadInput) {
  imageUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleMediaSelect(file);
    closeAttachMenu();
  });
}

// 2. 사진 즉시 촬영
if (cameraPhotoInput) {
  cameraPhotoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleMediaSelect(file);
    closeAttachMenu();
  });
}

// 3. 동영상 즉시 촬영
if (cameraVideoInput) {
  cameraVideoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleMediaSelect(file);
    closeAttachMenu();
  });
}

function handleMediaSelect(file) {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/i.test(file.name);

  if (!isImage && !isVideo) {
    alert('이미지 또는 동영상 파일만 첨부할 수 있습니다.');
    return;
  }

  selectedMediaFile = file;
  selectedMediaType = isVideo ? 'video' : 'image';

  if (isVideo) {
    imagePreviewThumb.classList.add('hidden');
    videoPreviewIcon.classList.remove('hidden');
    imagePreviewName.textContent = file.name || '동영상_촬영.mp4';
    const mbSize = (file.size / (1024 * 1024)).toFixed(1);
    imagePreviewSize.textContent = mbSize > 0 ? `${mbSize} MB` : `${(file.size / 1024).toFixed(1)} KB`;
    imagePreviewBar.classList.remove('hidden');
  } else {
    videoPreviewIcon.classList.add('hidden');
    imagePreviewThumb.classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = (e) => {
      imagePreviewThumb.src = e.target.result;
      imagePreviewName.textContent = file.name || '사진_이미지.png';
      imagePreviewSize.textContent = (file.size / 1024).toFixed(1) + ' KB';
      imagePreviewBar.classList.remove('hidden');
      if (window.innerWidth >= 768) {
        messageInput.focus();
      }
    };
    reader.readAsDataURL(file);
  }
}

btnRemoveImage.addEventListener('click', () => {
  clearSelectedMedia();
});

function clearSelectedMedia() {
  selectedMediaFile = null;
  selectedMediaType = 'image';
  if (imageUploadInput) imageUploadInput.value = '';
  if (cameraPhotoInput) cameraPhotoInput.value = '';
  if (cameraVideoInput) cameraVideoInput.value = '';
  imagePreviewBar.classList.add('hidden');
  imagePreviewThumb.src = '';
  videoPreviewIcon.classList.add('hidden');
  imagePreviewThumb.classList.remove('hidden');
}

// ==================== 인스타그램 감성 그리기 (Canvas) ====================
const drawColors = [
  '#ffffff', // 흰색
  '#000000', // 검정
  '#ff3b30', // 레드
  '#ff9500', // 오렌지
  '#ffcc00', // 옐로우
  '#34c759', // 그린
  '#007aff', // 블루
  '#5856d6', // 퍼플
  '#ff2d55'  // 핫핑크
];

let drawCtx = null;
let isDrawing = false;
let currentDrawColor = '#ffffff';
let isEraserMode = false;
let drawHistory = [];

function initDrawingCanvas() {
  if (!drawingCanvas) return;
  drawCtx = drawingCanvas.getContext('2d');

  // 컬러 팔레트 생성
  if (colorPalette && colorPalette.children.length === 0) {
    drawColors.forEach((color, idx) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = `draw-color-dot ${idx === 0 ? 'active' : ''}`;
      dot.style.backgroundColor = color;
      dot.addEventListener('click', () => {
        isEraserMode = false;
        currentDrawColor = color;
        eraserBtnText.textContent = '지우개';
        btnEraserMode.classList.remove('bg-rose-600', 'text-white');
        btnEraserMode.classList.add('bg-white/10');
        colorPalette.querySelectorAll('.draw-color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
      });
      colorPalette.appendChild(dot);
    });
  }

  // 지우개 모드 토글
  if (btnEraserMode) {
    btnEraserMode.addEventListener('click', () => {
      isEraserMode = !isEraserMode;
      if (isEraserMode) {
        eraserBtnText.textContent = '펜 모드';
        btnEraserMode.classList.add('bg-rose-600', 'text-white');
        btnEraserMode.classList.remove('bg-white/10');
        colorPalette.querySelectorAll('.draw-color-dot').forEach((d) => d.classList.remove('active'));
      } else {
        eraserBtnText.textContent = '지우개';
        btnEraserMode.classList.remove('bg-rose-600', 'text-white');
        btnEraserMode.classList.add('bg-white/10');
      }
    });
  }

  // 되돌리기 (Undo)
  if (btnUndoDraw) {
    btnUndoDraw.addEventListener('click', () => {
      if (drawHistory.length > 0) {
        const lastState = drawHistory.pop();
        const img = new Image();
        img.onload = () => {
          drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
          drawCtx.drawImage(img, 0, 0);
        };
        img.src = lastState;
      } else {
        drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
      }
    });
  }

  // 전체 지우기
  if (btnClearDraw) {
    btnClearDraw.addEventListener('click', () => {
      saveDrawState();
      drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
    });
  }

  // 캔버스 마우스 & 터치 이벤트
  const getCanvasCoords = (e) => {
    const rect = drawingCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const scaleX = drawingCanvas.width / rect.width;
    const scaleY = drawingCanvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const startDraw = (e) => {
    e.preventDefault();
    isDrawing = true;
    saveDrawState();
    const { x, y } = getCanvasCoords(e);
    drawCtx.beginPath();
    drawCtx.moveTo(x, y);
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    drawCtx.lineWidth = Number(drawLineWidth?.value || 6);

    if (isEraserMode) {
      drawCtx.globalCompositeOperation = 'destination-out';
      drawCtx.lineWidth = Number(drawLineWidth?.value || 6) * 2.5;
    } else {
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.strokeStyle = currentDrawColor;
    }
  };

  const moveDraw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const { x, y } = getCanvasCoords(e);
    drawCtx.lineTo(x, y);
    drawCtx.stroke();
  };

  const stopDraw = (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    isDrawing = false;
    drawCtx.closePath();
  };

  drawingCanvas.addEventListener('mousedown', startDraw);
  drawingCanvas.addEventListener('mousemove', moveDraw);
  window.addEventListener('mouseup', stopDraw);

  drawingCanvas.addEventListener('touchstart', startDraw, { passive: false });
  drawingCanvas.addEventListener('touchmove', moveDraw, { passive: false });
  window.addEventListener('touchend', stopDraw, { passive: false });
}

function saveDrawState() {
  if (!drawingCanvas) return;
  drawHistory.push(drawingCanvas.toDataURL());
  if (drawHistory.length > 20) drawHistory.shift();
}

function resizeDrawCanvas() {
  if (!drawingCanvas) return;
  const container = drawingCanvas.parentElement;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  const width = Math.floor(rect.width) || 400;
  const height = Math.floor(rect.height) || 500;

  // 기존 그림 보존
  let tempCanvas = null;
  if (drawingCanvas.width > 0 && drawingCanvas.height > 0) {
    tempCanvas = document.createElement('canvas');
    tempCanvas.width = drawingCanvas.width;
    tempCanvas.height = drawingCanvas.height;
    tempCanvas.getContext('2d').drawImage(drawingCanvas, 0, 0);
  }

  drawingCanvas.width = width * (window.devicePixelRatio || 1);
  drawingCanvas.height = height * (window.devicePixelRatio || 1);

  if (tempCanvas && drawCtx) {
    drawCtx.drawImage(tempCanvas, 0, 0, drawingCanvas.width, drawingCanvas.height);
  }
}

// 그리기 모달 열기/닫기/완료
if (btnOpenDrawModal) {
  btnOpenDrawModal.addEventListener('click', () => {
    closeAttachMenu();
    drawModal.classList.remove('hidden');
    initDrawingCanvas();
    setTimeout(() => {
      resizeDrawCanvas();
    }, 100);
  });
}

if (btnCloseDraw) {
  btnCloseDraw.addEventListener('click', () => {
    drawModal.classList.add('hidden');
  });
}

if (btnFinishDraw) {
  btnFinishDraw.addEventListener('click', () => {
    if (!drawingCanvas) return;
    // 캔버스를 이미지 Blob 파일로 변환하여 첨부
    drawingCanvas.toBlob((blob) => {
      if (blob) {
        const drawFile = new File([blob], `draw_${Date.now()}.png`, { type: 'image/png' });
        handleMediaSelect(drawFile);
        drawModal.classList.add('hidden');
        showToast({ title: '그림이 첨부되었습니다! 전송을 누르세요.', body: '', isSilent: true });
      }
    }, 'image/png');
  });
}

// ==================== 답장 (Reply) & 복사 (Copy) ====================
window.startReplyMessage = function(msgId) {
  if (!currentRoom || !currentRoom.messages) return;
  const targetMsg = currentRoom.messages.find((m) => m.id === msgId);
  if (!targetMsg) return;

  replyingToMessage = targetMsg;
  const targetName = targetMsg.senderDisplayName || targetMsg.senderName || '상대방';
  let targetSnippet = targetMsg.text;
  if (!targetSnippet) {
    targetSnippet = targetMsg.fileType === 'video' ? '[동영상]' : '[사진]';
  }

  replyTargetName.textContent = targetName;
  replyTargetText.textContent = targetSnippet;
  replyModeIndicator.classList.remove('hidden');

  if (editingMessageId) cancelEditMode();
  messageInput.focus();
};

window.cancelReplyMode = function() {
  replyingToMessage = null;
  if (replyModeIndicator) replyModeIndicator.classList.add('hidden');
};

if (btnCancelReply) {
  btnCancelReply.addEventListener('click', cancelReplyMode);
}

// 메시지 복사
window.copyMessageText = function(msgId) {
  if (!currentRoom || !currentRoom.messages) return;
  const targetMsg = currentRoom.messages.find((m) => m.id === msgId);
  if (!targetMsg) return;

  const textToCopy = targetMsg.text || targetMsg.fileUrl || '';
  if (!textToCopy) return;

  navigator.clipboard.writeText(textToCopy).then(() => {
    showToast({ title: '메시지가 클립보드에 복사되었습니다.', body: '', isSilent: true });
  }).catch(() => {
    // 대체 복사
    const tempInput = document.createElement('textarea');
    tempInput.value = textToCopy;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    showToast({ title: '메시지가 클립보드에 복사되었습니다.', body: '', isSilent: true });
  });
};

// 답장 원본 메시지로 이동
window.scrollToMessage = function(targetId) {
  if (!targetId) return;
  const el = document.getElementById(`msg-el-${targetId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-message');
    setTimeout(() => {
      el.classList.remove('highlight-message');
    }, 1500);
  } else {
    showToast({ title: '원본 메시지를 찾을 수 없습니다.', body: '', isSilent: true });
  }
};

// 마크다운 텍스트 포맷팅 (취소선 ~~취소선~~, **굵게**, *기울임*, __밑줄__)
function formatMessageText(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);

  // 1. 취소선: ~~텍스트~~
  formatted = formatted.replace(/~~(.*?)~~/g, '<del class="chat-strike">$1</del>');

  // 2. 굵게: **텍스트**
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold">$1</strong>');

  // 3. 기울임: *텍스트*
  formatted = formatted.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>');

  // 4. 밑줄: __텍스트__
  formatted = formatted.replace(/__(.*?)__/g, '<u class="underline">$1</u>');

  // 5. 줄바꿈
  formatted = formatted.replace(/\n/g, '<br>');

  return formatted;
}

// 라이트박스
window.openLightbox = function(url, fileName) {
  lightboxImg.src = url;
  btnDownloadLightbox.href = url;
  btnDownloadLightbox.setAttribute('download', fileName || 'photo.jpg');
  lightboxModal.classList.remove('hidden');
};

btnCloseLightbox.addEventListener('click', () => {
  lightboxModal.classList.add('hidden');
  lightboxImg.src = '';
});

lightboxModal.addEventListener('click', (e) => {
  if (e.target === lightboxModal) {
    lightboxModal.classList.add('hidden');
    lightboxImg.src = '';
  }
});

// ==================== 1. 로그인 (아이디 + 비밀번호) & 자동 로그인 유지 ====================
function getAvatarElement(avatarUrl, name, sizeClasses = 'w-8 h-8 text-xs') {
  const isImage = avatarUrl && (avatarUrl.startsWith('/') || avatarUrl.startsWith('http'));
  const isEmoji = avatarUrl && !isImage;

  if (isImage) {
    return `<img src="${getFullUrl(avatarUrl)}" alt="${escapeHtml(name)}" class="${sizeClasses} rounded-full object-cover shrink-0 border border-slate-200">`;
  } else if (isEmoji) {
    return `<div class="${sizeClasses} rounded-full bg-slate-100 flex items-center justify-center shrink-0 border border-slate-200 text-base leading-none select-none">${avatarUrl}</div>`;
  } else {
    const char = escapeHtml((name || '?').charAt(0).toUpperCase());
    return `<div class="${sizeClasses} rounded-full bg-blue-100 text-blue-600 font-bold flex items-center justify-center shrink-0 border border-slate-200">${char}</div>`;
  }
}

function updateMyHeaderProfile() {
  if (!currentUser) return;
  const name = currentUser.displayName || currentUser.username;
  myUsername.textContent = name;
  if (myStatusText) {
    myStatusText.textContent = currentUser.statusMessage || '';
  }

  if (currentUser.avatarUrl) {
    if (currentUser.avatarUrl.startsWith('/') || currentUser.avatarUrl.startsWith('http')) {
      myAvatarImg.src = currentUser.avatarUrl;
      myAvatarImg.classList.remove('hidden');
      myAvatarChar.classList.add('hidden');
    } else {
      myAvatarChar.textContent = currentUser.avatarUrl;
      myAvatarChar.classList.remove('hidden');
      myAvatarImg.classList.add('hidden');
    }
  } else {
    myAvatarChar.textContent = name.charAt(0).toUpperCase();
    myAvatarChar.classList.remove('hidden');
    myAvatarImg.classList.add('hidden');
  }
}

function updateProfileModalPreview(avatarUrl, name) {
  const isImage = avatarUrl && (avatarUrl.startsWith('/') || avatarUrl.startsWith('http'));
  const isEmoji = avatarUrl && !isImage;

  if (isImage) {
    profileModalAvatarImg.src = avatarUrl;
    profileModalAvatarImg.classList.remove('hidden');
    profileModalAvatarChar.classList.add('hidden');
  } else if (isEmoji) {
    profileModalAvatarChar.textContent = avatarUrl;
    profileModalAvatarChar.classList.remove('hidden');
    profileModalAvatarImg.classList.add('hidden');
  } else {
    profileModalAvatarChar.textContent = (name || '?').charAt(0).toUpperCase();
    profileModalAvatarChar.classList.remove('hidden');
    profileModalAvatarImg.classList.add('hidden');
  }
}

function openProfileModal() {
  if (!currentUser) return;
  inputDisplayName.value = currentUser.displayName || currentUser.username;
  inputStatusMessage.value = currentUser.statusMessage || '';
  tempProfileAvatarUrl = currentUser.avatarUrl || '';
  updateProfileModalPreview(tempProfileAvatarUrl, inputDisplayName.value);
  profileModal.classList.remove('hidden');
}

function closeProfileModal() {
  profileModal.classList.add('hidden');
}

function performLogin(username, password) {
  const trimmedUser = (username || '').trim();
  const trimmedPass = (password || '').trim();
  if (!trimmedUser || !trimmedPass) return;

  socket.emit('user_login', { username: trimmedUser, password: trimmedPass }, (res) => {
    if (res.success) {
      currentUser = res.user;
      userProfilesMap.set(currentUser.username, currentUser);

      // 브라우저에 로그인 정보 영구 기억 (새로고침/재방문 시 계속 자동 로그인)
      const authData = { username: trimmedUser, password: trimmedPass };
      localStorage.setItem('chat_saved_user', JSON.stringify(authData));
      syncAuthToGateway(authData);

      updateMyHeaderProfile();
      loginModal.classList.add('hidden');

      const partner = currentUser.username === '김범서' ? '조민아' : '김범서';
      startDirectMessage(partner);

      // 대기 중인 전화가 있다면 즉시 수신
      socket.emit('check_pending_call');

      // 알림 권한 자동 요청
      // - 아이폰 일반 사파리 탭: 홈 화면 추가 후 실행해야 하므로 가이드 모달 표시
      // - 아이폰 PWA(홈 화면) / 안드로이드 / PC: 로그인 직후 바로 OS 권한 팝업 띄우기
      if ('Notification' in window && Notification.permission === 'default') {
        if (isIOS && !isStandalone) {
          // 아이폰 사파리 일반 탭 → 홈 화면 추가 안내
          setTimeout(() => { iosPwaModal.classList.remove('hidden'); }, 800);
        } else {
          // 갤럭시 / PC / 아이폰 PWA → 즉시 OS 알림 허용 팝업
          setTimeout(() => {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                updateNotificationButtonUI();
                subscribePushNotification();
              }
            }).catch(() => { });
          }, 800);
        }
      } else if ('Notification' in window && Notification.permission === 'granted') {
        subscribePushNotification();
      }

      // 서버가 재시작된 경우 기존 구독을 자동으로 서버에 재등록 (푸시 알림 한 번 설정하면 쭉 유지)
      setTimeout(() => ensurePushSubscriptionRegistered(), 2000);
    } else {
      loginErrorMsg.textContent = res.message || '아이디 또는 비밀번호가 일치하지 않습니다.';
      loginErrorMsg.classList.remove('hidden');
      loginModal.classList.remove('hidden');
    }
  });
}

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();
  if (username && password) {
    performLogin(username, password);
  }
});

// 소켓 재연결 시 (서버를 내렸다 다시 켜도 무조건 자동 로그인 복구 + 푸시 구독 자동 재등록)
socket.on('connect', () => {
  const savedUserJson = localStorage.getItem('chat_saved_user');
  if (savedUserJson) {
    try {
      const { username, password } = JSON.parse(savedUserJson);
      performLogin(username, password);
    } catch (e) { }
  }
});

// 서버 재시작 후 로그인이 완료될 때마다 푸시 구독을 서버에 자동 재등록 (한 번 설정한 푸시 알림이 영원히 유지)
async function ensurePushSubscriptionRegistered() {
  if (!currentUser) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // 브라우저에 구독 자체가 없으면 스킵 (사용자가 알림 버튼을 한 번도 누르지 않은 상태)

    // 브라우저에 구독이 있으면 → 서버가 재시작되어 메모리가 날아갔더라도 즉시 재등록
    await fetch(getFullUrl('/api/save-subscription'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser.username, subscription: sub.toJSON() })
    });
    console.log('[Web Push] 서버 재시작 후 푸시 구독 자동 재등록 완료');
  } catch (e) {
    // 서버가 아직 준비 중이면 무시
  }
}

// ==================== 2. 방 선택 및 1:1 대화 ====================
// 모바일 뒤로가기 버튼
btnBackToRooms.addEventListener('click', () => {
  mainSidebar.classList.remove('hidden');
  chatArea.classList.add('hidden');
  chatArea.classList.remove('flex');
});

// 화면 크기 변경 시 레이아웃 복원
window.addEventListener('resize', () => {
  if (window.innerWidth >= 768) {
    mainSidebar.classList.remove('hidden');
    chatArea.classList.remove('hidden');
    chatArea.classList.add('flex');
  }
});

function selectRoom(roomId, roomName, type, targetUsername = null) {
  currentRoomId = roomId;
  currentTargetUsername = targetUsername;

  let titleText = roomName;
  if (type === 'dm' && targetUsername) {
    const targetProfile = userProfilesMap.get(targetUsername);
    if (targetProfile) {
      titleText = targetProfile.displayName || targetUsername;
    }
  }

  currentRoomTitle.innerHTML = type === 'dm'
    ? `<i class="fa-regular fa-user text-blue-500 mr-1.5"></i> ${escapeHtml(titleText)}`
    : `<i class="fa-solid fa-hashtag text-indigo-500 mr-1.5"></i> ${escapeHtml(titleText)}`;

  if (type === 'dm' && targetUsername) {
    callActionGroup.classList.remove('hidden');
  } else {
    callActionGroup.classList.add('hidden');
  }

  // 모바일 화면에서는 사이드바를 숨기고 채팅창을 전체화면으로 전환
  if (window.innerWidth < 768) {
    mainSidebar.classList.add('hidden');
    chatArea.classList.remove('hidden');
    chatArea.classList.add('flex');
  }

  socket.emit('join_room', { roomId }, (res) => {
    if (res.success) {
      currentRoom = res.room;
      renderMessages(currentRoom.messages);
    }
  });

  cancelEditMode();
  cancelReplyMode();
  clearSelectedMedia();
  stopMyTyping();
  activeTypingUsers.clear();
  renderTypingIndicator();
}

function startDirectMessage(targetUsername) {
  if (!currentUser || targetUsername === currentUser.username) return;

  socket.emit('create_or_get_dm', { targetUsername }, (res) => {
    if (res.success) {
      selectRoom(res.room.id, targetUsername, 'dm', targetUsername);
      tabRooms.click();
    }
  });
}

// ==================== 3. 메시지 렌더링 & 시간 포맷 ====================

function formatShortTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? '오후' : '오전';
  hours = hours % 12;
  hours = hours ? hours : 12;
  return `${ampm} ${hours}:${minutes}`;
}

function renderMessages(messages) {
  messagesContainer.innerHTML = '';
  if (!messages || messages.length === 0) {
    return;
  }

  messages.forEach((msg) => {
    appendMessage(msg, false);
  });

  // 첨부된 모든 사진/이미지가 비동기 로딩될 때마다 높이 변화에 맞춰 맨 아래 위치 고정
  const imgs = messagesContainer.querySelectorAll('img');
  imgs.forEach((img) => {
    if (!img.complete) {
      img.addEventListener('load', () => scrollToBottom(false), { once: true });
      img.addEventListener('error', () => scrollToBottom(false), { once: true });
    }
  });

  // 대화의 맨 마지막(최신 메시지)으로 강제 스크롤
  scrollToBottom(false);
}

function appendMessage(msg, scroll = true) {
  if (msg.isSystem) {
    const sysEl = document.createElement('div');
    sysEl.className = 'system-message';
    sysEl.innerHTML = `<span><i class="fa-solid fa-circle-info mr-1"></i>${escapeHtml(msg.text)}</span>`;
    messagesContainer.appendChild(sysEl);
    if (scroll) scrollToBottom();
    return;
  }

  const isMy = currentUser && msg.senderName === currentUser.username;
  const row = document.createElement('div');
  row.className = `message-row ${isMy ? 'my-message' : 'other-message'}`;
  row.id = `msg-el-${msg.id}`;

  const shortTime = formatShortTime(msg.timestamp);

  // 안 읽은 수 표시: 카카오톡 스타일 (상대방이 안 읽었으면 1, 읽었으면 공백)
  const showUnread = isMy && msg.unreadCount > 0;
  const unreadBadgeHtml = showUnread ? `<span class="unread-badge" id="unread-${msg.id}">1</span>` : '';

  // 무음 전송 아이콘
  const silentIconHtml = msg.isSilent ? `<span class="text-[10px] text-slate-300 mr-1"><i class="fa-solid fa-bell-slash"></i></span>` : '';

  // 수정됨 태그
  const editedTagHtml = msg.isEdited ? `<span class="text-[10px] opacity-75 ml-1.5 font-normal">(수정됨)</span>` : '';

  // 답장 인용 박스 렌더링
  let replyQuoteHtml = '';
  if (msg.replyTo) {
    const replySender = escapeHtml(msg.replyTo.senderDisplayName || msg.replyTo.senderName || '상대방');
    const replySnippet = escapeHtml(msg.replyTo.text || (msg.replyTo.fileType === 'video' ? '[동영상]' : '[사진]'));
    replyQuoteHtml = `
      <div class="reply-quote-box flex items-center justify-between gap-1" onclick="scrollToMessage('${msg.replyTo.id}')" title="원본 메시지로 이동">
        <div class="truncate">
          <span class="font-bold mr-1">${replySender}</span>
          <span class="opacity-80">${replySnippet}</span>
        </div>
        <i class="fa-solid fa-arrow-turn-up text-[10px] opacity-60 shrink-0"></i>
      </div>
    `;
  }

  // 액션 버튼: 내 메시지는 [답장, 복사, 수정, 삭제], 상대방 메시지는 [답장, 복사]
  let actionsHtml = '';
  if (!msg.isDeleted) {
    if (isMy) {
      actionsHtml = `
        <div class="message-actions">
          <button class="message-action-btn reply-btn" onclick="startReplyMessage('${msg.id}')"><i class="fa-solid fa-reply"></i> 답장</button>
          <button class="message-action-btn copy-btn" onclick="copyMessageText('${msg.id}')"><i class="fa-regular fa-copy"></i> 복사</button>
          ${!msg.fileUrl ? `<button class="message-action-btn edit-btn" onclick="startEditMessage('${msg.id}', '${encodeURIComponent(msg.text)}')"><i class="fa-solid fa-pen"></i> 수정</button>` : ''}
          <button class="message-action-btn delete-btn" onclick="deleteMessage('${msg.id}')">
            <i class="fa-solid fa-trash-can"></i> 삭제
          </button>
        </div>
      `;
    } else {
      actionsHtml = `
        <div class="message-actions">
          <button class="message-action-btn reply-btn" onclick="startReplyMessage('${msg.id}')"><i class="fa-solid fa-reply"></i> 답장</button>
          <button class="message-action-btn copy-btn" onclick="copyMessageText('${msg.id}')"><i class="fa-regular fa-copy"></i> 복사</button>
        </div>
      `;
    }
  }

  let bubbleContent = '';
  if (msg.isDeleted) {
    bubbleContent = `<span class="deleted-message px-3 py-1.5 rounded-lg inline-block text-xs"><i class="fa-solid fa-ban mr-1"></i>삭제된 메시지입니다.</span>`;
  } else {
    let mediaHtml = '';
    const isVideo = msg.type === 'video' || msg.fileType === 'video' || (msg.fileUrl && /\.(mp4|webm|mov|m4v)$/i.test(msg.fileUrl));

    if (msg.fileUrl) {
      if (isVideo) {
        mediaHtml = `
          <div class="mb-1 overflow-hidden rounded-xl bg-black">
            <video src="${getFullUrl(msg.fileUrl)}" controls playsinline preload="metadata" class="max-w-xs sm:max-w-sm max-h-72 rounded-xl w-full block"></video>
          </div>
        `;
      } else {
        mediaHtml = `
          <div class="mb-1 cursor-pointer group relative overflow-hidden rounded-xl bg-slate-900/10" onclick="openLightbox('${getFullUrl(msg.fileUrl)}', '${escapeHtml(msg.fileName || '')}')">
            <img src="${getFullUrl(msg.fileUrl)}" alt="전송된 사진" loading="lazy" class="max-w-xs sm:max-w-sm max-h-72 object-cover rounded-xl transition duration-200 group-hover:scale-105">
            <div class="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs font-semibold gap-1">
              <i class="fa-solid fa-magnifying-glass-plus"></i> 크게 보기
            </div>
          </div>
        `;
      }
    }

    const textHtml = msg.text
      ? `<div class="leading-relaxed text-sm break-words">${formatMessageText(msg.text)}${editedTagHtml}</div>`
      : '';

    bubbleContent = `
      <div class="message-bubble ${isMy ? 'bg-blue-600 text-white' : 'bg-white text-slate-800'}">
        ${replyQuoteHtml}
        ${mediaHtml}
        ${textHtml}
      </div>
    `;
  }

  if (isMy) {
    row.innerHTML = `
      ${actionsHtml}
      <div class="meta-info">
        ${unreadBadgeHtml}
        <span class="time-stamp flex items-center">
          ${silentIconHtml}${shortTime}
        </span>
      </div>
      ${bubbleContent}
    `;

    // 모바일 터치 시 액션 메뉴 토글
    if (!msg.isDeleted) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.message-actions') || e.target.closest('.reply-quote-box') || e.target.closest('video')) return;
        row.classList.toggle('active');
      });
    }
  } else {
    const senderProfile = userProfilesMap.get(msg.senderName);
    const senderDisplay = senderProfile?.displayName || msg.senderDisplayName || msg.senderName;
    const senderAvatar = senderProfile?.avatarUrl !== undefined ? senderProfile.avatarUrl : (msg.senderAvatarUrl || '');
    const avatarHtml = getAvatarElement(senderAvatar, senderDisplay, 'w-8 h-8 text-xs mr-2');

    row.innerHTML = `
      ${avatarHtml}
      <div>
        <div class="text-[11px] text-slate-400 font-medium mb-1">${escapeHtml(senderDisplay)}</div>
        <div class="flex items-end">
          ${bubbleContent}
          <div class="meta-info">
            <span class="time-stamp flex items-center">
              ${silentIconHtml}${shortTime}
            </span>
          </div>
        </div>
      </div>
      ${actionsHtml}
    `;

    // 모바일 터치 시 액션 메뉴 토글 (답장/복사)
    if (!msg.isDeleted) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.message-actions') || e.target.closest('.reply-quote-box') || e.target.closest('video')) return;
        row.classList.toggle('active');
      });
    }
  }

  messagesContainer.appendChild(row);

  const imgEl = row.querySelector('img');
  if (imgEl && !imgEl.complete) {
    imgEl.addEventListener('load', () => scrollToBottom(false), { once: true });
    imgEl.addEventListener('error', () => scrollToBottom(false), { once: true });
  }

  const vidEl = row.querySelector('video');
  if (vidEl) {
    vidEl.addEventListener('loadedmetadata', () => scrollToBottom(false), { once: true });
  }

  if (scroll) scrollToBottom();
}

function scrollToBottom(smooth = false) {
  if (!messagesContainer) return;

  const doScroll = () => {
    if (!messagesContainer) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    const lastChild = messagesContainer.lastElementChild;
    if (lastChild && typeof lastChild.scrollIntoView === 'function') {
      try {
        lastChild.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
      } catch (e) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }
  };

  // 1. 즉시 1회 실행
  doScroll();

  // 2. 브라우저 다음 렌더링 프레임에 재실행
  requestAnimationFrame(() => {
    doScroll();
    requestAnimationFrame(doScroll);
  });

  // 3. 모바일 레이아웃 계산 지연 및 이미지 렌더링 타이밍 대응 다단계 보장
  setTimeout(doScroll, 50);
  setTimeout(doScroll, 150);
  setTimeout(doScroll, 300);
  setTimeout(doScroll, 500);
}

// ==================== 4. 메시지 및 사진/동영상 전송 ====================

messageForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let text = messageInput.value.trim();

  if (!text && !selectedMediaFile) return;

  if (editingMessageId) {
    socket.emit('edit_message', {
      roomId: currentRoomId,
      messageId: editingMessageId,
      newText: text
    }, (res) => {
      if (res.success) {
        cancelEditMode();
      } else {
        alert(res.message || '수정 실패');
      }
    });
  } else {
    let fileUrl = null;
    let fileName = null;
    let fileSize = null;
    let fileType = null;

    if (selectedMediaFile) {
      btnSendText.textContent = '업로드 중...';
      try {
        const formData = new FormData();
        formData.append('image', selectedMediaFile);

        const uploadRes = await fetch(getFullUrl('/api/upload'), {
          method: 'POST',
          body: formData
        });
        const uploadData = await uploadRes.json();

        if (uploadData.success) {
          fileUrl = uploadData.fileUrl;
          fileName = uploadData.fileName;
          fileSize = uploadData.fileSize;
          fileType = uploadData.fileType || selectedMediaType;
        } else {
          alert('파일 업로드 실패: ' + uploadData.message);
          btnSendText.textContent = '전송';
          return;
        }
      } catch (err) {
        console.error('업로드 에러:', err);
        alert('파일 저장 중 오류가 발생했습니다.');
        btnSendText.textContent = '전송';
        return;
      }
    }

    // /silent, /slient, /무음, /조용히 명령어 체크
    let isSilent = toggleSilentSend.checked;
    const silentMatch = text.match(/^\/(?:silent|slient|무음|조용히)\s*(.*)/i);
    if (silentMatch) {
      isSilent = true;
      text = silentMatch[1].trim();
    }

    const replyPayload = replyingToMessage ? {
      id: replyingToMessage.id,
      senderName: replyingToMessage.senderName,
      senderDisplayName: replyingToMessage.senderDisplayName || replyingToMessage.senderName,
      text: replyingToMessage.text || '',
      fileUrl: replyingToMessage.fileUrl || null,
      fileType: replyingToMessage.fileType || null
    } : null;

    stopMyTyping();

    socket.emit('send_message', {
      roomId: currentRoomId,
      text,
      isSilent,
      fileUrl,
      fileName,
      fileSize,
      fileType,
      replyTo: replyPayload
    }, (res) => {
      btnSendText.textContent = '전송';
      if (res.success) {
        messageInput.value = '';
        clearSelectedMedia();
        cancelReplyMode();
        stopMyTyping();
        if (window.innerWidth >= 768 && document.activeElement !== messageInput) {
          messageInput.focus();
        }
      }
    });
  }
});

// 수정 모드
window.startEditMessage = function(messageId, encodedText) {
  editingMessageId = messageId;
  const originalText = decodeURIComponent(encodedText);
  messageInput.value = originalText;
  messageInput.focus();
  editModeIndicator.classList.remove('hidden');
  btnSendText.textContent = '수정 완료';
};

function cancelEditMode() {
  editingMessageId = null;
  messageInput.value = '';
  editModeIndicator.classList.add('hidden');
  btnSendText.textContent = '전송';
}

btnCancelEdit.addEventListener('click', cancelEditMode);

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (editingMessageId) cancelEditMode();
    if (!lightboxModal.classList.contains('hidden')) {
      lightboxModal.classList.add('hidden');
      lightboxImg.src = '';
    }
  }
});

// 메시지 삭제
window.deleteMessage = function(messageId) {
  if (!confirm('이 메시지(사진)를 정말 삭제하시겠습니까?')) return;

  socket.emit('delete_message', {
    roomId: currentRoomId,
    messageId
  }, (res) => {
    if (!res.success) {
      alert(res.message || '삭제 실패');
    }
  });
};

// ==================== 실시간 타이핑 인디케이터 ====================
function startMyTyping() {
  if (!isMyTypingActive && socket && socket.connected) {
    isMyTypingActive = true;
    socket.emit('typing_start', { roomId: currentRoomId });
  }
  clearTimeout(myTypingTimer);
  myTypingTimer = setTimeout(() => {
    stopMyTyping();
  }, 2500);
}

function stopMyTyping() {
  clearTimeout(myTypingTimer);
  if (isMyTypingActive && socket && socket.connected) {
    isMyTypingActive = false;
    socket.emit('typing_stop', { roomId: currentRoomId });
  }
}

function renderTypingIndicator() {
  let typingEl = document.getElementById('typing-indicator-row');

  if (activeTypingUsers.size === 0) {
    if (typingEl) typingEl.remove();
    return;
  }

  const typingUser = Array.from(activeTypingUsers.values())[0];
  const dispName = escapeHtml(typingUser.displayName || typingUser.username);
  const avatarHtml = getAvatarElement(typingUser.avatarUrl, dispName, 'w-8 h-8 text-xs mr-2');

  if (!typingEl) {
    typingEl = document.createElement('div');
    typingEl.id = 'typing-indicator-row';
    typingEl.className = 'message-row other-message my-1.5 transition-all duration-200';
    messagesContainer.appendChild(typingEl);
  }

  typingEl.innerHTML = `
    ${avatarHtml}
    <div class="message-bubble bg-white text-slate-700 py-2.5 px-3.5 rounded-2xl shadow-xs border border-slate-100 flex items-center gap-1.5 w-fit">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;

  scrollToBottom(true);
}

// ==================== 5. 소켓 이벤트 수신 ====================

socket.on('user_typing_start', ({ roomId, username, displayName, avatarUrl }) => {
  if (roomId !== currentRoomId) return;
  if (currentUser && username === currentUser.username) return;

  activeTypingUsers.set(username, { username, displayName, avatarUrl });
  renderTypingIndicator();
});

socket.on('user_typing_stop', ({ roomId, username }) => {
  if (roomId !== currentRoomId) return;
  activeTypingUsers.delete(username);
  renderTypingIndicator();
});

socket.on('new_message', (msg) => {
  if (msg.roomId === currentRoomId) {
    // 새 메시지가 오면 상대방의 타이핑 표시 즉시 제거
    activeTypingUsers.delete(msg.senderName);
    renderTypingIndicator();

    appendMessage(msg, true);
    if (document.hasFocus() && currentUser && msg.senderName !== currentUser.username) {
      socket.emit('mark_read', { roomId: currentRoomId });
    }
  }
});

socket.on('messages_read_bulk', ({ roomId, username }) => {
  if (roomId === currentRoomId && currentUser && username !== currentUser.username) {
    const unreadBadges = messagesContainer.querySelectorAll('.unread-badge');
    unreadBadges.forEach((badge) => {
      badge.remove();
    });
  }
});

socket.on('message_edited', ({ roomId, messageId, newText, editedAt }) => {
  if (roomId === currentRoomId) {
    const row = document.getElementById(`msg-el-${messageId}`);
    if (row) {
      const bubble = row.querySelector('.leading-relaxed');
      if (bubble) {
        bubble.innerHTML = `${escapeHtml(newText)} <span class="text-[10px] opacity-75 ml-1.5 font-normal">(수정됨)</span>`;
      }
    }
  }
});

socket.on('message_deleted', ({ roomId, messageId }) => {
  if (roomId === currentRoomId) {
    const row = document.getElementById(`msg-el-${messageId}`);
    if (row) {
      row.remove(); // 화면에서 흔적도 없이 완전 삭제
    }
  }
});

socket.on('user_list', (users) => {
  renderUserList(users);
});

socket.on('user_profile_updated', (profile) => {
  userProfilesMap.set(profile.username, profile);
  if (currentUser && currentUser.username === profile.username) {
    currentUser.displayName = profile.displayName;
    currentUser.avatarUrl = profile.avatarUrl;
    currentUser.statusMessage = profile.statusMessage;
    updateMyHeaderProfile();
  }
  if (currentTargetUsername === profile.username) {
    const disp = profile.displayName || profile.username;
    currentRoomTitle.innerHTML = `<i class="fa-regular fa-user text-blue-500 mr-1.5"></i> ${escapeHtml(disp)}`;
  }
});

socket.on('room_list', (rooms) => {
  renderRoomList(rooms);
});

socket.on('notification', (noti) => {
  const isSilent = isSilentModeEnabled || noti.isSilent;

  showToast({
    title: `${noti.senderName}님의 새 메시지 ${isSilent ? '🔕' : '🔔'}`,
    body: noti.text,
    isSilent,
    onClick: () => {
      selectRoom(noti.roomId, noti.senderName, 'dm', noti.senderName);
    }
  });

  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    showNativeNotification(`${noti.senderName} (${isSilent ? '무음' : '알림'})`, {
      body: noti.text,
      silent: isSilent,
      tag: 'msg-' + (noti.messageId || Date.now())
    });
  }

  if (!isSilent) {
    audioNotification.currentTime = 0;
    audioNotification.play().catch(() => { });
  }
});

// ==================== 6. 사이드바 UI ====================

function renderUserList(users) {
  panelUsers.innerHTML = '';
  users.forEach((u) => {
    userProfilesMap.set(u.username, u);
  });

  const otherUsers = users.filter((u) => !currentUser || u.username !== currentUser.username);

  otherUsers.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'p-3 rounded-xl hover:bg-slate-50 transition flex items-center justify-between cursor-pointer border border-transparent hover:border-slate-200';
    const avatarHtml = getAvatarElement(u.avatarUrl, u.displayName || u.username, 'w-10 h-10 text-sm');
    const statusHtml = u.statusMessage ? `<div class="text-[11px] text-slate-400 truncate max-w-[150px] mt-0.5">${escapeHtml(u.statusMessage)}</div>` : '';

    item.innerHTML = `
      <div class="flex items-center space-x-3 min-w-0">
        <div class="relative shrink-0">
          ${avatarHtml}
          <span class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full ring-2 ring-white ${u.isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}"></span>
        </div>
        <div class="min-w-0">
          <div class="text-xs font-bold text-slate-800 truncate">${escapeHtml(u.displayName || u.username)}</div>
          ${statusHtml}
        </div>
      </div>
      <div class="flex items-center space-x-1 shrink-0 ml-2">
        <button class="w-8 h-8 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 flex items-center justify-center transition" title="1:1 대화">
          <i class="fa-regular fa-comment-dots text-sm"></i>
        </button>
      </div>
    `;

    item.addEventListener('click', () => {
      startDirectMessage(u.username);
    });

    panelUsers.appendChild(item);
  });
}

function renderRoomList(rooms) {
  panelRooms.innerHTML = '';

  rooms.forEach((r) => {
    const isActive = r.id === currentRoomId;
    const item = document.createElement('div');
    item.className = `p-3 rounded-xl transition flex items-center justify-between cursor-pointer border ${isActive ? 'bg-blue-50/70 border-blue-200 text-blue-900 font-bold' : 'hover:bg-slate-50 border-transparent text-slate-700'
      }`;

    let avatarOrIconHtml = '';
    if (r.type === 'dm') {
      avatarOrIconHtml = getAvatarElement(r.avatarUrl, r.name, 'w-8 h-8 text-xs mr-2.5');
    } else {
      avatarOrIconHtml = `<div class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs mr-2.5 shrink-0"><i class="fa-solid fa-hashtag"></i></div>`;
    }

    const badge = r.unreadTotal > 0 ? `<span class="px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-bold shrink-0">${r.unreadTotal}</span>` : '';

    item.innerHTML = `
      <div class="flex items-center min-w-0 truncate">
        ${avatarOrIconHtml}
        <span class="text-xs truncate font-medium">${escapeHtml(r.name)}</span>
      </div>
      <div>${badge}</div>
    `;

    item.addEventListener('click', () => {
      const targetUser = r.type === 'dm' ? r.name : null;
      selectRoom(r.id, r.name, r.type, targetUser);
    });

    panelRooms.appendChild(item);
  });
}

// ==================== 7. 토스트 알림 ====================

function showToast({ title, body, isSilent, onClick }) {
  const toast = document.createElement('div');
  toast.className = `toast-item pointer-events-auto bg-white/95 backdrop-blur border border-slate-200 rounded-xl shadow-xl p-3.5 w-72 text-left cursor-pointer transition transform hover:scale-[1.02] flex items-start space-x-3`;

  toast.innerHTML = `
    <div class="w-8 h-8 rounded-full ${isSilent ? 'bg-amber-100 text-amber-600' : 'bg-blue-100 text-blue-600'} flex items-center justify-center text-xs shrink-0">
      <i class="${isSilent ? 'fa-solid fa-bell-slash' : 'fa-regular fa-bell'}"></i>
    </div>
    <div class="flex-1 truncate">
      <div class="text-xs font-bold text-slate-800 flex items-center justify-between">
        <span class="truncate">${escapeHtml(title)}</span>
        ${isSilent ? '<span class="text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded">무음</span>' : ''}
      </div>
      <div class="text-xs text-slate-500 truncate mt-0.5">${escapeHtml(body)}</div>
    </div>
  `;

  if (onClick) {
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }

  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

// ==================== 8. WebRTC 전화 (음성 / 영상 통화) ====================

btnStartVoiceCall.addEventListener('click', () => {
  if (!currentTargetUsername) {
    alert('통화할 상대를 선택해주세요.');
    return;
  }
  startOutgoingCall(currentTargetUsername, 'voice');
});

btnStartVideoCall.addEventListener('click', () => {
  if (!currentTargetUsername) {
    alert('통화할 상대를 선택해주세요.');
    return;
  }
  startOutgoingCall(currentTargetUsername, 'video');
});

// 미디어(오디오/비디오) 스트림 획득 함수 (모바일 전면 카메라 최적화 및 호환성 처리)
async function getMediaStream(callType) {
  if (callType === 'voice') {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  }

  // 영상 통화의 경우: 모바일 전면 카메라 해상도 최적화 (대역폭 과부하 방지 및 60fps 부드러운 연결)
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: {
        facingMode: 'user',
        width: { ideal: 640, max: 1280 },
        height: { ideal: 480, max: 720 },
        frameRate: { ideal: 24, max: 30 }
      }
    });
  } catch (err) {
    console.warn('전면 카메라 옵션 실패, 기본 카메라 제약으로 재시도:', err);
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
    } catch (e2) {
      console.error('카메라 권한 접근 완전 실패:', e2);
      throw e2;
    }
  }
}

async function startOutgoingCall(targetUsername, callType) {
  isCallConnectingOrActive = true;
  stopRingtone();

  activeCallTargetUsername = targetUsername;
  activeCallType = callType;

  openCallOverlay(targetUsername, '상대방에게 연결 요청 중...');

  try {
    localStream = await getMediaStream(callType);
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => { });

    if (callType === 'voice') {
      localVideoContainer.classList.add('hidden');
      remoteVideo.classList.add('hidden');
      voiceOnlyAvatar.classList.remove('hidden');
    } else {
      localVideoContainer.classList.remove('hidden');
      remoteVideo.classList.remove('hidden');
      voiceOnlyAvatar.classList.add('hidden');
    }

    socket.emit('call_user', { targetUsername, callType });
  } catch (err) {
    console.error('마이크/카메라 접근 실패:', err);
    alert('마이크 또는 카메라 권한이 필요합니다: ' + err.message);
    cleanupCall();
  }
}

socket.on('incoming_call', ({ callerSocketId, callerName, callType }) => {
  // 이미 통화 중이거나 통화 연결 진행 중이면 중복 수신 모달 및 벨소리 무시
  if (isCallConnectingOrActive || peerConnection) {
    console.log('[통화 중] 통화 연결 진행 중이므로 수신 요청 무시');
    return;
  }

  pendingIncomingCall = { callerSocketId, callerName, callType };

  callerNameDisplay.textContent = callerName;
  incomingCallTypeDisplay.textContent = callType === 'video' ? '📹 영상 통화 요청' : '📞 음성 통화 요청';
  incomingCallIcon.className = callType === 'video' ? 'fa-solid fa-video' : 'fa-solid fa-phone-volume';

  incomingCallModal.classList.remove('hidden');

  // 백그라운드 상태일 때 전화 수신 시스템 푸시 알림 표시
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    showNativeNotification(`📞 ${callerName}님의 전화 요청`, {
      body: callType === 'video' ? '영상 통화가 걸려왔습니다. 터치하여 수락하세요.' : '음성 통화가 걸려왔습니다. 터치하여 수락하세요.',
      requireInteraction: true,
      tag: 'incoming-call'
    });
  }

  playRingtone();
});

// 발신자가 전화를 취소한 경우 → 수신 모달 자동 닫기
socket.on('call_cancelled', ({ callerName }) => {
  stopRingtone();
  isCallConnectingOrActive = false;
  incomingCallModal.classList.add('hidden');
  pendingIncomingCall = null;
  showToast({
    title: `${callerName}님이 전화를 취소했습니다.`,
    body: '',
    isSilent: true
  });
});

btnAcceptCall.addEventListener('click', async () => {
  if (!pendingIncomingCall) return;

  // 1. 벨소리 즉시 완전 정지
  stopRingtone();
  // 2. 통화 연결 중 플래그 활성화 (이후 추가적인 벨소리 재생 및 check_pending_call 차단)
  isCallConnectingOrActive = true;
  incomingCallModal.classList.add('hidden');

  const { callerSocketId, callerName, callType } = pendingIncomingCall;
  pendingIncomingCall = null;

  activeCallTargetSocketId = callerSocketId;
  activeCallTargetUsername = callerName;
  activeCallType = callType;

  openCallOverlay(callerName, '통화 연결 중...');

  try {
    localStream = await getMediaStream(callType);
    localVideo.srcObject = localStream;
    localVideo.play().catch(() => { });

    if (callType === 'voice') {
      localVideoContainer.classList.add('hidden');
      remoteVideo.classList.add('hidden');
      voiceOnlyAvatar.classList.remove('hidden');
    } else {
      localVideoContainer.classList.remove('hidden');
      remoteVideo.classList.remove('hidden');
      voiceOnlyAvatar.classList.add('hidden');
    }

    // 마이크 권한 얻은 직후에도 벨소리 정지 재차 보장
    stopRingtone();

    socket.emit('answer_call', { targetSocketId: callerSocketId, accepted: true });
  } catch (err) {
    console.error('미디어 접근 실패:', err);
    alert('마이크/카메라 권한을 얻을 수 없습니다: ' + err.message);
    socket.emit('answer_call', { targetSocketId: callerSocketId, accepted: false, reason: 'permission_denied' });
    cleanupCall();
  }
});

btnRejectCall.addEventListener('click', () => {
  if (!pendingIncomingCall) return;
  stopRingtone();
  isCallConnectingOrActive = false;
  incomingCallModal.classList.add('hidden');

  socket.emit('answer_call', {
    targetSocketId: pendingIncomingCall.callerSocketId,
    accepted: false,
    reason: 'declined'
  });

  pendingIncomingCall = null;
});

// WebRTC ICE 후보 버퍼 (상대방 sdp 적용 전 도착한 ICE candidate 보관용)
let pendingIceCandidates = [];

async function flushPendingIceCandidates() {
  if (peerConnection && peerConnection.remoteDescription && pendingIceCandidates.length > 0) {
    for (const cand of pendingIceCandidates) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) { }
    }
    pendingIceCandidates = [];
  }
}

socket.on('call_answered', async ({ responderSocketId, responderName, accepted, reason }) => {
  stopRingtone();

  if (!accepted) {
    isCallConnectingOrActive = false;
    alert(`${responderName}님이 통화를 거절했습니다. (${reason || '바쁨'})`);
    cleanupCall();
    return;
  }

  isCallConnectingOrActive = true;
  activeCallTargetSocketId = responderSocketId;
  activeCallStatus.textContent = 'P2P 연결 수립 중...';

  initPeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('webrtc_offer', {
    targetSocketId: responderSocketId,
    sdp: offer
  });
});

socket.on('webrtc_offer', async ({ callerSocketId, sdp }) => {
  activeCallTargetSocketId = callerSocketId;
  initPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  await flushPendingIceCandidates();

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('webrtc_answer', {
    targetSocketId: callerSocketId,
    sdp: answer
  });
});

socket.on('webrtc_answer', async ({ responderSocketId, sdp }) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    await flushPendingIceCandidates();
  }
});

socket.on('webrtc_ice_candidate', async ({ fromSocketId, candidate }) => {
  if (!candidate) return;
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('ICE Candidate 추가 실패', e);
    }
  } else {
    pendingIceCandidates.push(candidate);
  }
});

socket.on('call_ended', () => {
  showToast({
    title: '통화 종료',
    body: '상대방이 통화를 종료했습니다.',
    isSilent: true
  });
  cleanupCall();
});

// 백그라운드 오디오 유지를 위한 Web Audio Keep-Alive
let audioContext = null;
let keepAliveOscillator = null;

function startSilentKeepAlive() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }
    // 소리 없는 초저음 오실레이터로 모바일 OS의 백그라운드 오디오 일시정지 방지
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    gain.gain.value = 0.001; // 거의 무음에 가까운 레벨
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    keepAliveOscillator = osc;
  } catch (e) {
    console.warn('AudioContext keep-alive 실패:', e);
  }
}

function stopSilentKeepAlive() {
  if (keepAliveOscillator) {
    try {
      keepAliveOscillator.stop();
      keepAliveOscillator.disconnect();
    } catch (e) { }
    keepAliveOscillator = null;
  }
}

function setupMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${activeCallTargetUsername || '상대방'} 통화 중`,
      artist: 'Talk & Call',
      album: '실시간 음성 통화'
    });
    navigator.mediaSession.playbackState = 'playing';

    navigator.mediaSession.setActionHandler('hangup', () => {
      btnHangup.click();
    });
  }
}

function cleanupMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
  }
}

// Picture-in-Picture (화면 속 화면) 지원: 다른 앱을 보거나 백그라운드에서도 영상 통화 유지
async function togglePictureInPicture() {
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (remoteVideo.webkitSupportsPresentationMode && typeof remoteVideo.webkitSetPresentationMode === 'function') {
      remoteVideo.webkitSetPresentationMode(
        remoteVideo.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture'
      );
    } else if (document.pictureInPictureEnabled && remoteVideo.requestPictureInPicture) {
      await remoteVideo.requestPictureInPicture();
    }
  } catch (err) {
    console.warn('PIP 전환 실패:', err);
  }
}

if (btnPipCall) {
  btnPipCall.addEventListener('click', togglePictureInPicture);
}

// 통화 최소화 버튼 이벤트 (통화하면서 채팅하기 + 영상통화 시 PIP 활성화)
btnMinimizeCall.addEventListener('click', () => {
  activeCallOverlay.classList.add('hidden');
  floatingCallBar.classList.remove('hidden');
  floatingCallName.textContent = `${activeCallTargetUsername || '상대방'} 통화 중`;
  if (activeCallType === 'video') {
    togglePictureInPicture();
  }
});

// 플로팅 바 터치 시 다시 전체 통화화면으로 복원
floatingCallBar.addEventListener('click', (e) => {
  if (e.target.closest('#btn-floating-hangup')) return;
  activeCallOverlay.classList.remove('hidden');
  floatingCallBar.classList.add('hidden');
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => { });
  }
});

// 플로팅 바에서 바로 종료
btnFloatingHangup.addEventListener('click', (e) => {
  e.stopPropagation();
  btnHangup.click();
});

let disconnectGraceTimer = null;

function initPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) { }
    peerConnection = null;
  }
  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }
  pendingIceCandidates = [];

  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    // 통화 연결 완료 시 벨소리 즉시 100% 완전 정지
    stopRingtone();

    // 상대방 스트림 연결 (모바일 브라우저 호환성을 위해 play() 명시적 실행)
    const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
    remoteStream = stream;

    if (remoteVideo) {
      remoteVideo.srcObject = stream;
      remoteVideo.play().catch(() => { });
    }
    if (remoteAudio) {
      remoteAudio.srcObject = stream;
      remoteAudio.play().catch(() => { });
    }

    activeCallStatus.textContent = activeCallType === 'video' ? '영상 통화 중' : '음성 통화 중';
    startCallTimer();

    // 백그라운드 재생 지속 설정
    setupMediaSession();
    startSilentKeepAlive();
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && activeCallTargetSocketId) {
      socket.emit('webrtc_ice_candidate', {
        targetSocketId: activeCallTargetSocketId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('[WebRTC 상태]:', state);

    if (state === 'connected') {
      if (disconnectGraceTimer) {
        clearTimeout(disconnectGraceTimer);
        disconnectGraceTimer = null;
      }
      activeCallStatus.textContent = activeCallType === 'video' ? '영상 통화 중' : '음성 통화 중';
    } else if (state === 'disconnected') {
      // 모바일 백그라운드 전환/화면 꺼짐 시 일시적 네트워크 둔화 대응: 즉시 끊지 않고 20초간 유예
      activeCallStatus.textContent = '연결 복구 중...';
      if (!disconnectGraceTimer) {
        disconnectGraceTimer = setTimeout(() => {
          if (peerConnection && peerConnection.connectionState === 'disconnected') {
            console.log('[WebRTC] 20초간 연결이 회복되지 않아 통화 종료');
            cleanupCall();
          }
        }, 20000);
      }
    } else if (state === 'failed') {
      cleanupCall();
    }
  };
}

btnHangup.addEventListener('click', () => {
  if (activeCallTargetSocketId) {
    // 통화가 연결된 상태 → 상대 소켓에 end_call 전송
    socket.emit('end_call', { targetSocketId: activeCallTargetSocketId });
  } else if (activeCallTargetUsername) {
    // 전화 거는 중(상대가 아직 수락 안 한 상태) → 사용자명 기반으로 cancel_call 전송
    socket.emit('cancel_call', { targetUsername: activeCallTargetUsername });
  }
  cleanupCall();
});

btnToggleMic.addEventListener('click', () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    btnToggleMic.className = audioTrack.enabled
      ? 'w-13 h-13 rounded-full bg-slate-700 hover:bg-slate-600 text-white text-lg flex items-center justify-center transition shadow-lg'
      : 'w-13 h-13 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-lg flex items-center justify-center transition shadow-lg';
    btnToggleMic.innerHTML = audioTrack.enabled ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
  }
});

btnToggleCam.addEventListener('click', () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    btnToggleCam.className = videoTrack.enabled
      ? 'w-13 h-13 rounded-full bg-slate-700 hover:bg-slate-600 text-white text-lg flex items-center justify-center transition shadow-lg'
      : 'w-13 h-13 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-lg flex items-center justify-center transition shadow-lg';
    btnToggleCam.innerHTML = videoTrack.enabled ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
  }
});

function openCallOverlay(peerName, initialStatus) {
  activeCallPeerName.textContent = peerName;
  activeCallStatus.textContent = initialStatus;
  activeCallOverlay.classList.remove('hidden');
  callTimer.textContent = '00:00';
}

function startCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = Math.floor(callSeconds / 60).toString().padStart(2, '0');
    const s = (callSeconds % 60).toString().padStart(2, '0');
    const timeStr = `${m}:${s}`;
    callTimer.textContent = timeStr;
    if (floatingCallTimer) floatingCallTimer.textContent = timeStr;
  }, 1000);
}

function cleanupCall() {
  isCallConnectingOrActive = false;
  pendingIncomingCall = null;
  stopRingtone();
  stopSilentKeepAlive();
  cleanupMediaSession();

  if (disconnectGraceTimer) {
    clearTimeout(disconnectGraceTimer);
    disconnectGraceTimer = null;
  }

  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => { });
  }

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  callSeconds = 0;

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  if (remoteAudio) {
    remoteAudio.srcObject = null;
  }

  activeCallOverlay.classList.add('hidden');
  if (floatingCallBar) floatingCallBar.classList.add('hidden');
  incomingCallModal.classList.add('hidden');
  activeCallTargetSocketId = null;
  activeCallTargetUsername = null;
  pendingIncomingCall = null;
}

function playRingtone() {
  if (isSilentModeEnabled) return;
  if (isCallConnectingOrActive || peerConnection) return;

  isRingtonePlaying = true;
  try {
    audioRingtone.currentTime = 0;
    const playPromise = audioRingtone.play();
    if (playPromise !== undefined) {
      playPromise.then(() => {
        // play() 비동기 완료 후 이미 정지 플래그가 켜져 있으면 즉각 정지
        if (!isRingtonePlaying || isCallConnectingOrActive || peerConnection) {
          audioRingtone.pause();
          audioRingtone.currentTime = 0;
        }
      }).catch(() => { });
    }
  } catch (e) { }
}

function stopRingtone() {
  isRingtonePlaying = false;
  try {
    audioRingtone.pause();
    audioRingtone.currentTime = 0;
  } catch (e) { }

  // 알림 센터에 떠 있는 전화 수신 배너도 즉시 자동 닫기
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage({
      type: 'CLOSE_NOTIFICATION',
      tag: 'incoming-call'
    });
  }
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
