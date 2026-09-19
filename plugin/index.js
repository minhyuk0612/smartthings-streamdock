const { Plugins, Actions, log } = require('./utils/plugin');
const { execFile } = require('child_process');
const plugin = new Plugins();
const { startOAuthServer } = require('../oauth-server/server');
startOAuthServer();
function openSmartThingsLogin() {
    const url = 'http://localhost:3000/login';
    execFile(
        'cmd.exe',
        ['/c', 'start', '', url],
        { windowsHide: true },
        (error) => {
            if (error) {
                log.error('Failed to open SmartThings login:', error);
            }
        }
    );
}
async function handlePropertyInspectorMessage(payload) {
    if (payload?.action === 'getDevices') {
        const target = { action: Actions.currentAction, context: Actions.currentContext };
        try {
            const devices = await getDevices();
            plugin.sendToPropertyInspector({ type: 'devices', requestId: payload.requestId, devices }, target);
        } catch {
            plugin.sendToPropertyInspector({ type: 'devicesError', requestId: payload.requestId }, target);
        }
        return true;
    }
    if (!payload || payload.action !== 'oauthLogin') {
        return false;
    }
    try {
        openSmartThingsLogin();
        plugin.sendToPropertyInspector({
            type: 'oauthLoginStarted'
        });
    } catch (error) {
        log.error(
            'Failed to open SmartThings OAuth login',
            error
        );
        plugin.sendToPropertyInspector({
            type: 'oauthLoginError',
            message: error.message
        });
    }
    return true;
}
// ------------------------------------------------------------
// SmartThings API
// ------------------------------------------------------------
async function smartThingsRequest(path, options = {}) {
    let localPath = path;
    // 기존 SmartThings 경로를 로컬 OAuth 서버 경로로 변환
    if (path.startsWith('/devices/')) {
        localPath = `/api${path}`;
    }
    const response = await fetch(
        `http://localhost:3000${localPath}`,
        {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        }
    );
    if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
            const body = await response.text();
            if (body) {
                message += `: ${body}`;
            }
        } catch (_) {}
        throw new Error(message);
    }
    const data = await response.json();
    // OAuth 서버 wrapper 제거
    if (data.success === false) {
        throw new Error(
            data.error || 'SmartThings request failed.'
        );
    }
    if (path.endsWith('/status')) {
        return data.status;
    }
    if (path.endsWith('/commands')) {
        return data.result;
    }
    return data;
}
// ------------------------------------------------------------
// Device list
// ------------------------------------------------------------
async function getDevices() {
    const data =
        await smartThingsRequest('/devices');
    return data.devices || [];
}
const brightnessLevels = new Map();
const brightnessTimers = new Map();
const colorTemperatures = new Map();
const colorTemperatureTimers = new Map();
// ------------------------------------------------------------
// Device status
// ------------------------------------------------------------
async function getSwitchState(deviceId) {
    if (!deviceId) {
        throw new Error('SmartThings 기기를 선택하세요.');
    }
    const data =
        await smartThingsRequest(
            `/devices/${deviceId}/status`
        );
    return (
        data?.components?.main?.switch?.switch?.value
        || 'unknown'
    );
}
// ------------------------------------------------------------
// Device command
// ------------------------------------------------------------
async function setSwitchState(deviceId, command) {
    if (!deviceId) {
        throw new Error('SmartThings 기기를 선택하세요.');
    }
    await smartThingsRequest(
        `/devices/${deviceId}/commands`,
        {
            method: 'POST',
            body: JSON.stringify({
                commands: [
                    {
                        component: 'main',
                        capability: 'switch',
                        command
                    }
                ]
            })
        }
    );
}
async function getBrightness(deviceId) {
    if (!deviceId) {
        throw new Error('Select a SmartThings device.');
    }
    const data = await smartThingsRequest(
        `/devices/${deviceId}/status`
    );
    const level =
        data?.components?.main?.switchLevel?.level?.value;
    if (typeof level !== 'number') {
        throw new Error('This device does not support brightness.');
    }
    return level;
}
async function getColorTemperature(deviceId) {
    if (!deviceId) {
        throw new Error('Select a SmartThings device.');
    }
    const data = await smartThingsRequest(
        `/devices/${deviceId}/status`
    );
    const temperature =
        data?.components?.main
            ?.colorTemperature
            ?.colorTemperature
            ?.value;
    if (typeof temperature !== 'number') {
        throw new Error(
            'This device does not support color temperature.'
        );
    }
    return temperature;
}
async function setColorTemperature(deviceId, temperature) {
    if (!deviceId) {
        throw new Error('Select a SmartThings device.');
    }
    temperature = Math.max(
        2000,
        Math.min(6500, Math.round(temperature))
    );
    await smartThingsRequest(
        `/devices/${deviceId}/commands`,
        {
            method: 'POST',
            body: JSON.stringify({
                commands: [
                    {
                        component: 'main',
                        capability: 'colorTemperature',
                        command: 'setColorTemperature',
                        arguments: [temperature]
                    }
                ]
            })
        }
    );
    return temperature;
}
async function refreshBrightness(context, action) {
    const settings = action.data[context] || {};
    if (!settings.deviceId) {
        plugin.setTitle(context, 'NO DEVICE');
        return;
    }
    try {
        const state = await getSwitchState(settings.deviceId);
        if (state !== 'on') {
            plugin.setTitle(context, 'OFF');
            return;
        }
        const level = await getBrightness(settings.deviceId);
        brightnessLevels.set(context, level);
        plugin.setTitle(
            context,
            `${Math.round(level)}%`
        );
    } catch (error) {
        log.error(
            'Brightness refresh failed',
            error
        );
        plugin.setTitle(context, 'ERROR');
    }
}
async function setBrightness(deviceId, level) {
    if (!deviceId) {
        throw new Error('Select a SmartThings device.');
    }
    level = Math.max(0, Math.min(100, Math.round(level)));
    await smartThingsRequest(
        `/devices/${deviceId}/commands`,
        {
            method: 'POST',
            body: JSON.stringify({
                commands: [
                    {
                        component: 'main',
                        capability: 'switchLevel',
                        command: 'setLevel',
                        arguments: [level]
                    }
                ]
            })
        }
    );
    return level;
}
// ------------------------------------------------------------
// N4 image
// ------------------------------------------------------------
function renderSwitch(state, label = 'SmartThings') {
    const isOn = state === 'on';
    let displayLabel = label || 'SmartThings';
    if (displayLabel.length > 12) {
        displayLabel =
            displayLabel.substring(0, 11) + '…';
    }
    const svg = `
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="144"
            height="144">
            <rect
                width="144"
                height="144"
                rx="22"
                fill="${
                    isOn
                        ? 'rgb(42,125,72)'
                        : 'rgb(38,38,43)'
                }"
            />
            <text
                x="72"
                y="54"
                font-family="Arial"
                font-size="17"
                fill="white"
                text-anchor="middle">
                ${escapeXml(displayLabel)}
            </text>
            <text
                x="72"
                y="103"
                font-family="Arial"
                font-size="34"
                font-weight="bold"
                fill="white"
                text-anchor="middle">
                ${
                    state === 'unknown'
                        ? '?'
                        : isOn
                            ? 'ON'
                            : 'OFF'
                }
            </text>
        </svg>
    `;
    return (
        'data:image/svg+xml;charset=utf8,' +
        encodeURIComponent(svg)
    );
}
function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&')
        .replaceAll('<', '<')
        .replaceAll('>', '>')
        .replaceAll('"', '"')
        .replaceAll("'", '&apos;');
}
// ------------------------------------------------------------
// Refresh N4 key
// ------------------------------------------------------------
async function refreshKey(context, action) {
    const settings =
        action.data[context] || {};
    if (!settings.deviceId) {
        plugin.setImage(
            context,
            renderSwitch(
                'unknown',
                '기기 선택'
            )
        );
        return;
    }
    try {
        const state =
            await getSwitchState(
                settings.deviceId
            );
        plugin.setImage(
            context,
            renderSwitch(
                state,
                settings.deviceLabel
            )
        );
        plugin.sendToPropertyInspector({
    type: 'status',
    state
});
    } catch (error) {
        log.error(
            'SmartThings refresh failed',
            error
        );
        plugin.showAlert(context);
        plugin.sendToPropertyInspector({
    type: 'error',
    message: error.message
});
    }
}
// ------------------------------------------------------------
// Action
//
// UUID의 마지막 부분이 count이므로 현재는 plugin.count를 유지.
// manifest 변경 단계에서 toggle로 정리한다.
// ------------------------------------------------------------
plugin.toggle = new Actions({
    default: {
        deviceId: '',
        deviceLabel: ''
    },
    async _willAppear({ context }) {
        await refreshKey(
            context,
            this
        );
    },
    async keyUp({ context }) {
        const settings =
            this.data[context];
        if (!settings.deviceId) {
            plugin.showAlert(context);
            return;
        }
        try {
            const current =
                await getSwitchState(
                    settings.deviceId
                );
            const command =
                current === 'on'
                    ? 'off'
                    : 'on';
            await setSwitchState(
                settings.deviceId,
                command
            );
            // SmartThings 상태 반영 대기
            await new Promise(
                resolve =>
                    setTimeout(resolve, 500)
            );
            await refreshKey(
                context,
                this
            );
            plugin.showOk(context);
        } catch (error) {
            log.error(
                'SmartThings toggle failed',
                error
            );
            plugin.showAlert(context);
        }
    },
    async sendToPlugin({ context, payload }) {
    if (!payload) return;
    if (await handlePropertyInspectorMessage(payload)) {
    return;
}
    if (payload.action === 'refresh') {
        await refreshKey(
            context,
            this
        );
    }
},
    async _didReceiveSettings({
        context
    }) {
        await refreshKey(
            context,
            this
        );
    },
    _willDisappear({
        context
    }) {}
});
plugin.brightness = new Actions({
    default: {
        deviceId: '',
        deviceLabel: ''
    },
    async _willAppear({ context }) {
        log.info('Brightness appeared', context);
        await refreshBrightness(
            context,
            this
        );
    },
    async sendToPlugin({ context, payload }) {
        if (!payload) return;
        if (await handlePropertyInspectorMessage(payload)) {
    return;
}
        if (payload.action === 'refresh') {
            await refreshBrightness(
                context,
                this
            );
        }
    },
    async _didReceiveSettings({ context }) {
    const settings = this.data[context] || {};
    log.info(
        'Brightness settings changed',
        JSON.stringify(settings)
    );
    brightnessLevels.delete(context);
    await refreshBrightness(
        context,
        this
    );
},
    async dialRotate({ context, payload }) {
    const settings = this.data[context] || {};
    if (!settings.deviceId) {
        plugin.showAlert(context);
        return;
    }
    try {
        let level = brightnessLevels.get(context);
        // 처음 돌렸을 때만 SmartThings에서 현재 밝기를 가져옴
        if (typeof level !== 'number') {
            level = await getBrightness(settings.deviceId);
        }
        const direction =
            payload.ticks > 0 ? 1 : -1;
        // 이벤트 1회당 5% 변경
        level = Math.max(
            0,
            Math.min(100, level + direction * 5)
        );
        brightnessLevels.set(context, level);
        // N4에는 즉시 목표 밝기를 표시
        plugin.setTitle(
            context,
            `${level}%`
        );
        // 이전 예약 전송 취소
        const oldTimer =
            brightnessTimers.get(context);
        if (oldTimer) {
            clearTimeout(oldTimer);
        }
        // 마지막 회전 후 400ms 동안 추가 입력이 없을 때
        // SmartThings에는 최종 밝기 한 번만 전송
        const timer = setTimeout(async () => {
            try {
                const finalLevel =
                    brightnessLevels.get(context);
                await setBrightness(
                    settings.deviceId,
                    finalLevel
                );
                log.info(
                    'Brightness sent',
                    `${finalLevel}%`
                );
            } catch (error) {
                log.error(
                    'Brightness send failed',
                    error
                );
                plugin.showAlert(context);
            }
        }, 400);
        brightnessTimers.set(
            context,
            timer
        );
    } catch (error) {
        log.error(
            'Brightness read failed',
            error
        );
        plugin.showAlert(context);
    }
},
    async dialDown({ context }) {
    const settings = this.data[context] || {};
    if (!settings.deviceId) {
        plugin.showAlert(context);
        return;
    }
    try {
        const current =
            await getSwitchState(settings.deviceId);
        const command =
            current === 'on'
                ? 'off'
                : 'on';
        await setSwitchState(
    settings.deviceId,
    command
);
if (command === 'off') {
    plugin.setTitle(context, 'OFF');
} else {
    // 켜졌을 때 기존에 기억한 밝기를 우선 표시
    const level = brightnessLevels.get(context);
    if (typeof level === 'number') {
        plugin.setTitle(
            context,
            `${Math.round(level)}%`
        );
    } else {
        plugin.setTitle(context, 'ON');
    }
}
plugin.showOk(context);
        log.info(
            'Brightness knob toggle',
            `${current} -> ${command}`
        );
    } catch (error) {
        log.error(
            'Brightness knob toggle failed',
            error
        );
        plugin.showAlert(context);
    }
},
    dialUp(data) {
        log.info(
            'DIAL UP',
            JSON.stringify(data)
        );
    },
    _willDisappear({ context }) {
    const timer =
        brightnessTimers.get(context);
    if (timer) {
        clearTimeout(timer);
    }
    brightnessTimers.delete(context);
    brightnessLevels.delete(context);
    log.info(
        'Brightness disappeared',
        context
    );
    }
});
plugin.colortemperature = new Actions({
    default: {
        deviceId: '',
        deviceLabel: ''
    },
    async _willAppear({ context }) {
        log.info(
            'Color Temperature appeared',
            context
        );
        const settings = this.data[context] || {};
        if (!settings.deviceId) {
            plugin.setTitle(context, 'NO DEVICE');
            return;
        }
        try {
            const temperature =
                await getColorTemperature(
                    settings.deviceId
                );
            colorTemperatures.set(
                context,
                temperature
            );
            plugin.setTitle(
                context,
                `${temperature}K`
            );
        } catch (error) {
            log.error(
                'Color Temperature refresh failed',
                error
            );
            plugin.setTitle(context, 'ERROR');
        }
    },
    async sendToPlugin({ context, payload }) {
    if (!payload) return;
    if (await handlePropertyInspectorMessage(payload)) {
    return;
}
    if (payload.action === 'refresh') {
        const settings = this.data[context] || {};
        if (!settings.deviceId) {
            plugin.setTitle(context, 'NO DEVICE');
            return;
        }
        try {
            const temperature =
                await getColorTemperature(
                    settings.deviceId
                );
            colorTemperatures.set(
                context,
                temperature
            );
            plugin.setTitle(
                context,
                `${temperature}K`
            );
        } catch (error) {
            log.error(
                'Color Temperature refresh failed',
                error
            );
            plugin.setTitle(context, 'ERROR');
        }
    }
},
    async _didReceiveSettings({ context }) {
        const settings = this.data[context] || {};
        colorTemperatures.delete(context);
        if (!settings.deviceId) {
            plugin.setTitle(context, 'NO DEVICE');
            return;
        }
        try {
            const temperature =
                await getColorTemperature(
                    settings.deviceId
                );
            colorTemperatures.set(
                context,
                temperature
            );
            plugin.setTitle(
                context,
                `${temperature}K`
            );
        } catch (error) {
            log.error(
                'Color Temperature settings refresh failed',
                error
            );
            plugin.setTitle(context, 'ERROR');
        }
    },
    async dialRotate({ context, payload }) {
        const settings = this.data[context] || {};
        if (!settings.deviceId) {
            plugin.showAlert(context);
            return;
        }
        try {
            let temperature =
                colorTemperatures.get(context);
            // 캐시에 값이 없을 때만 API 조회
            if (typeof temperature !== 'number') {
                temperature =
                    await getColorTemperature(
                        settings.deviceId
                    );
            }
            const direction =
                payload.ticks > 0 ? 1 : -1;
            // 노브 이벤트 1회당 100K
            temperature += direction * 100;
            temperature = Math.max(
                2000,
                Math.min(6500, temperature)
            );
            colorTemperatures.set(
                context,
                temperature
            );
            // N4 화면은 즉시 변경
            plugin.setTitle(
                context,
                `${temperature}K`
            );
            const oldTimer =
                colorTemperatureTimers.get(context);
            if (oldTimer) {
                clearTimeout(oldTimer);
            }
            // 마지막 회전 400ms 후 SmartThings에 한 번만 전송
            const timer = setTimeout(async () => {
                try {
                    const finalTemperature =
                        colorTemperatures.get(context);
                    await setColorTemperature(
                        settings.deviceId,
                        finalTemperature
                    );
                    log.info(
                        'Color Temperature sent',
                        `${finalTemperature}K`
                    );
                } catch (error) {
                    log.error(
                        'Color Temperature send failed',
                        error
                    );
                    plugin.showAlert(context);
                }
            }, 400);
            colorTemperatureTimers.set(
                context,
                timer
            );
        } catch (error) {
            log.error(
                'Color Temperature read failed',
                error
            );
            plugin.showAlert(context);
        }
    },
    async dialDown({ context }) {
        const settings = this.data[context] || {};
        if (!settings.deviceId) {
            plugin.showAlert(context);
            return;
        }
        try {
            const current =
                await getSwitchState(
                    settings.deviceId
                );
            const command =
                current === 'on'
                    ? 'off'
                    : 'on';
            await setSwitchState(
                settings.deviceId,
                command
            );
            if (command === 'off') {
                plugin.setTitle(context, 'OFF');
            } else {
                const temperature =
                    colorTemperatures.get(context);
                if (typeof temperature === 'number') {
                    plugin.setTitle(
                        context,
                        `${temperature}K`
                    );
                } else {
                    plugin.setTitle(
                        context,
                        'ON'
                    );
                }
            }
            plugin.showOk(context);
        } catch (error) {
            log.error(
                'Color Temperature knob toggle failed',
                error
            );
            plugin.showAlert(context);
        }
    },
    dialUp(data) {
        log.info(
            'Color Temperature DIAL UP',
            JSON.stringify(data)
        );
    },
    _willDisappear({ context }) {
        const timer =
            colorTemperatureTimers.get(context);
        if (timer) {
            clearTimeout(timer);
        }
        colorTemperatureTimers.delete(context);
        colorTemperatures.delete(context);
        log.info(
            'Color Temperature disappeared',
            context
        );
    }
});