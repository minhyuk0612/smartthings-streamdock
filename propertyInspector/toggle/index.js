/// <reference path="../utils/common.js" />
/// <reference path="../utils/action.js" />
const $local = false;
const $back = false;
const $dom = {
    main: $('.sdpi-wrapper'), connect: $('#connect'), device: $('#device'),
    status: $('#status'), refresh: $('#refresh')
};
let devices = [];
let initialized = false;
let pendingRequest = null;
let requestTimeout = null;
let oauthCheckTimer = null;
let oauthDeadline = 0;
let requestNumber = 0;
const inspectorSession = Date.now().toString(36) + Math.random().toString(36).slice(2);

function stopOAuthCheck() {
    clearInterval(oauthCheckTimer);
    oauthCheckTimer = null;
}

function loadDevices() {
    if (pendingRequest || !$websocket || $websocket.readyState !== 1) return;
    pendingRequest = `${inspectorSession}-${++requestNumber}`;
    $dom.status.value = oauthCheckTimer ? '로그인 완료 확인 중...' : '연결 상태와 기기 목록 확인 중...';
    $dom.refresh.disabled = true;
    requestTimeout = setTimeout(() => {
        pendingRequest = null;
        $dom.refresh.disabled = false;
        $dom.status.value = '플러그인 응답이 없습니다. 기기 새로고침을 눌러주세요.';
    }, 15000);
    $websocket.sendToPlugin({ action: 'getDevices', requestId: pendingRequest });
}

function renderDevices(list) {
    devices = list;
    $dom.device.innerHTML = '<option value="">기기를 선택하세요</option>';
    for (const device of devices) {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || device.name || device.deviceId;
        $dom.device.appendChild(option);
    }
    $dom.device.value = $settings.deviceId || '';
    $dom.device.disabled = false;
    $dom.status.value = `SmartThings 연결됨 · ${devices.length}개 기기`;
}

const $propEvent = {
    didReceiveSettings({ settings }) {
        $dom.device.value = settings.deviceId || '';
        if (!initialized) {
            initialized = true;
            loadDevices();
        }
    },
    sendToPropertyInspector(data) {
        if (!data) return;
        if (data.type === 'devices' || data.type === 'devicesError') {
            if (data.requestId !== pendingRequest) return;
            clearTimeout(requestTimeout);
            pendingRequest = null;
            $dom.refresh.disabled = false;
            if (data.type === 'devices') {
                stopOAuthCheck();
                renderDevices(data.devices || []);
            } else {
                $dom.status.value = oauthCheckTimer
                    ? '브라우저에서 로그인을 완료해 주세요. 자동으로 다시 확인합니다.'
                    : '기기 목록을 불러오지 못했습니다. 새로고침하거나 SmartThings에 연결해 주세요.';
            }
        }
        if (data.type === 'oauthLoginError') {
            stopOAuthCheck();
            $dom.status.value = '로그인 페이지를 열지 못했습니다. 다시 연결해 주세요.';
            $dom.refresh.disabled = false;
        }
        // Device on/off state is separate from the OAuth connection status.
    }
};

$dom.connect.on('click', () => {
    stopOAuthCheck();
    oauthDeadline = Date.now() + 10 * 60 * 1000;
    $dom.status.value = '브라우저에서 SmartThings 로그인을 완료해 주세요.';
    $websocket.sendToPlugin({ action: 'oauthLogin' });
    oauthCheckTimer = setInterval(() => {
        if (Date.now() >= oauthDeadline) {
            stopOAuthCheck();
            $dom.refresh.disabled = false;
            $dom.status.value = '로그인 확인 시간이 지났습니다. 기기 새로고침을 눌러주세요.';
            return;
        }
        loadDevices();
    }, 2000);
});

$dom.device.on('change', () => {
    const device = devices.find(item => item.deviceId === $dom.device.value);
    if (!device) return;
    $settings.deviceId = device.deviceId;
    $settings.deviceLabel = device.label || device.name || 'SmartThings';
    // The settings proxy persists both fields together. The plugin's
    // didReceiveSettings handler refreshes the control with the new device.
});
$dom.refresh.on('click', loadDevices);
window.addEventListener('beforeunload', () => {
    stopOAuthCheck();
    clearTimeout(requestTimeout);
});
