/**
 * Talk & Call Service Worker (iOS & Android 백그라운드 원격 푸시 알림)
 */

const GATEWAY_URL = 'https://gimbumbucu.github.io/talk-site/';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 백그라운드 원격 푸시 수신 (앱을 보고 있지 않을 때만 OS 배너 표시)
self.addEventListener('push', (event) => {
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 사용자가 현재 앱 화면을 열어두고 보고 있다면 OS 푸시 배너를 띄우지 않음
      const isViewingApp = windowClients.some(
        (client) => client.visibilityState === 'visible' && client.focused
      );
      if (isViewingApp) return;

      let data = {
        title: 'Talk & Call',
        body: '새 메시지가 도착했습니다.',
        tag: 'chat-push'
      };

      if (event.data) {
        try {
          data = Object.assign(data, event.data.json());
        } catch (e) {
          data.body = event.data.text();
        }
      }

      const options = {
        body: data.body,
        icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
        vibrate: [200, 100, 200, 100, 200],
        tag: data.tag || 'chat-push',
        renotify: true,
        requireInteraction: Boolean(data.requireInteraction)
      };

      return self.registration.showNotification(data.title, options);
    })
  );
});

// 알림 클릭 시 → 고정 게이트웨이로 바로 이동 (서버 주소가 바뀌어도 항상 제대로 들어가짐)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // 이미 앱이 열려 있다면 그 창을 포커스하고 수신 확인 트리거 전달
      for (const client of windowClients) {
        if ('focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICKED', tag: event.notification.tag });
          return client.focus();
        }
      }
      // 앱이 닫혀있으면 고정 게이트웨이로 새 창 열기 (자동으로 현재 서버로 리다이렉트됨)
      return clients.openWindow(GATEWAY_URL);
    })
  );
});

// 클라이언트로부터 내부 메시지 수신
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = event.data;
    self.registration.showNotification(title, options);
  } else if (event.data && event.data.type === 'CLOSE_NOTIFICATION') {
    const tagToClose = event.data.tag;
    self.registration.getNotifications({ tag: tagToClose }).then((notifications) => {
      notifications.forEach((notification) => notification.close());
    });
  }
});
