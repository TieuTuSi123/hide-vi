// update.js - Module chức năng tự động kiểm tra cập nhật
import Logger from "./Logger.js";
import { getRequestHeaders } from '../../../../script.js';

// Cấu hình kho lưu trữ từ xa - Cần điều chỉnh theo địa chỉ kho thực tế
const REPO_ROOT = "https://raw.githubusercontent.com/TieuTuSi123/hide-vi/main";
const MANIFEST_URL = `${REPO_ROOT}/manifest.json`;
const CHANGELOG_URL = `${REPO_ROOT}/CHANGELOG.md`;

const extensionName = "hide";
const KEY_LAST_CHECK = `${extensionName}_last_update_check`;
const KEY_UPDATE_INFO = `${extensionName}_update_info`;

/**
 * Lấy phiên bản tiện ích cục bộ (bất đồng bộ)
 */
async function getLocalVersion() {
    try {
        // 1. Gọi API backend để phát hiện tất cả các tiện ích đã cài đặt
        const discoverResponse = await fetch('/api/extensions/discover');
        if (!discoverResponse.ok) return "Error (API)";

        const installedExtensions = await discoverResponse.json();

        // 2. Đọc đồng thời các tệp manifest.json
        const manifestPromises = installedExtensions.map(async (ext) => {
            try {
                const res = await fetch(`/scripts/extensions/${ext.name}/manifest.json`);
                if (res.ok) {
                    const json = await res.json();
                    return {
                        manifest: json,
                        folderPath: ext.name
                    };
                }
            } catch (e) {}
            return null;
        });

        const results = await Promise.all(manifestPromises);
        const validResults = results.filter(r => r !== null);

        // 3. Logic khớp tiện ích
        const target = validResults.find(item => {
            const m = item.manifest;
            const folder = item.folderPath;

            // Khớp theo tên hiển thị (hỗ trợ cả tiếng Việt và tiếng Trung gốc)
            if (m.display_name === "Trợ lý ẩn tầng" || m.display_name === "隐藏助手") return true;

            // Miễn là đường dẫn kết thúc bằng /hide, hoặc chính là hide
            if (folder === "hide" || folder.endsWith("/hide") || folder.endsWith("/hide-extension")) {
                return true;
            }

            return false;
        });

        if (target) {
            Logger.info(`Tìm thấy tiện ích cục bộ: ${target.folderPath}, phiên bản: ${target.manifest.version}`);
            return target.manifest.version || "No Version";
        }

        return "Unknown";

    } catch (error) {
        Logger.error('Kiểm tra phiên bản cục bộ thất bại:', error);
        return "Error";
    }
}

/**
 * Hàm so sánh phiên bản
 * @param {string} v1 - Phiên bản 1
 * @param {string} v2 - Phiên bản 2
 * @returns {number} 1 nếu v1 > v2, -1 nếu v1 < v2, 0 nếu bằng nhau
 */
function compareVersions(v1, v2) {
    if (!v1 || !v2) return 0;
    const p1 = v1.replace(/^v/, '').split('.').map(Number);
    const p2 = v2.replace(/^v/, '').split('.').map(Number);
    const len = Math.max(p1.length, p2.length);
    for (let i = 0; i < len; i++) {
        const n1 = p1[i] || 0;
        const n2 = p2[i] || 0;
        if (n1 > n2) return 1;
        if (n1 < n2) return -1;
    }
    return 0;
}

/**
 * Lấy phiên bản từ xa trên GitHub
 */
async function getRemoteVersion() {
    try {
        const response = await fetch(MANIFEST_URL + `?t=${Date.now()}`);
        if (!response.ok) return null;
        const data = await response.json();
        return data.version;
    } catch (error) {
        Logger.error('Lấy phiên bản từ xa thất bại:', error);
        return null;
    }
}

/**
 * Kiểm tra cập nhật
 * @param {boolean} force - Có bắt buộc kiểm tra hay không (bỏ qua cache)
 * @returns {Promise<Object>} Đối tượng thông tin cập nhật
 */
export async function checkForUpdates(force = false) {
    const now = Date.now();
    const lastCheck = localStorage.getItem(KEY_LAST_CHECK);

    // 1. Luôn lấy phiên bản cục bộ theo thời gian thực
    const localVer = await getLocalVersion();

    let remoteVer = null;
    let usedCache = false;

    // 2. Thử lấy phiên bản từ xa
    // Nếu không phải làm mới bắt buộc và cache chưa hết hạn (24h), trích xuất số phiên bản từ xa từ cache
    if (!force && lastCheck && (now - parseInt(lastCheck) < 86400000)) {
        const cachedStr = localStorage.getItem(KEY_UPDATE_INFO);
        if (cachedStr) {
            try {
                const cachedObj = JSON.parse(cachedStr);
                if (cachedObj && cachedObj.latestVersion && cachedObj.latestVersion !== "Check Failed") {
                    remoteVer = cachedObj.latestVersion;
                    usedCache = true;
                }
            } catch (e) {
                // Phân tích JSON thất bại, bỏ qua bộ nhớ đệm
            }
        }
    }

    // 3. Nếu không trúng bộ nhớ đệm (hoặc bắt buộc làm mới), gửi yêu cầu lên GitHub
    if (!remoteVer) {
        remoteVer = await getRemoteVersion();

        // Chỉ cập nhật mốc thời gian khi lấy thành công phiên bản từ xa
        if (remoteVer) {
            localStorage.setItem(KEY_LAST_CHECK, now.toString());
        }
    }

    // 4. So sánh phiên bản theo thời gian thực
    const hasUpdate = (remoteVer && localVer !== "Unknown" && localVer !== "Error")
        ? compareVersions(remoteVer, localVer) > 0
        : false;

    // Xây dựng đối tượng kết quả
    const result = {
        hasUpdate: hasUpdate,
        latestVersion: remoteVer || "Check Failed",
        localVersion: localVer,
        checkedAt: usedCache ? parseInt(lastCheck || now) : now
    };

    // 5. Cập nhật nội dung bộ nhớ đệm
    if (remoteVer) {
        localStorage.setItem(KEY_UPDATE_INFO, JSON.stringify(result));
    }

    return result;
}

/**
 * Lấy nội dung nhật ký cập nhật (Changelog)
 */
export async function getChangelog() {
    try {
        const response = await fetch(CHANGELOG_URL + `?t=${Date.now()}`);
        return await response.text();
    } catch (e) {
        Logger.error('Lấy nhật ký cập nhật thất bại:', e);
        return "Không thể lấy nhật ký cập nhật.";
    }
}

/**
 * Thực thi cập nhật tiện ích
 */
export async function performUpdate() {
    try {
        // Thực hiện lại logic tìm kiếm để lấy chính xác folderPath
        const discoverResponse = await fetch('/api/extensions/discover');
        const extensions = await discoverResponse.json();
        let targetFolder = null;
        let isGlobal = false;

        // Duyệt tìm kiếm đơn giản
        for (const ext of extensions) {
            try {
                const res = await fetch(`/scripts/extensions/${ext.name}/manifest.json`);
                if (res.ok) {
                    const m = await res.json();
                    // Logic khớp tương tự
                    if (m.display_name === "Trợ lý ẩn tầng" ||
                        m.display_name === "隐藏助手" ||
                        ext.name.endsWith("/hide") ||
                        ext.name === "hide") {
                        targetFolder = ext.name; // Ở đây có thể là "third-party/hide"
                        isGlobal = ext.type === 'global'; // Bắt kiểu tiện ích
                        break;
                    }
                }
            } catch(e) {}
        }

        if (!targetFolder) {
            Logger.error('Không tìm thấy thư mục tiện ích, không thể cập nhật');
            return { ok: false };
        }

        Logger.info(`Đang cập nhật tiện ích: ${targetFolder}`);

        // API backend yêu cầu loại bỏ tiền tố "third-party/" để lấy tên ngắn và truyền rõ tham số global
        const shortName = targetFolder.replace(/^third-party\//, '');

        // Dùng getRequestHeaders() thay vì tự ghép thủ công
        // getRequestHeaders() sẽ tự động trả về { 'Content-Type': 'application/json', 'X-CSRF-Token': '...' }
        return await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: shortName,
                global: isGlobal
            })
        });
    } catch (e) {
        Logger.error('Cập nhật thất bại:', e);
        return { ok: false };
    }
}

/**
 * Khởi tạo kiểm tra cập nhật (Tự động gọi khi tải trang)
 */
export async function initUpdateCheck() {
    try {
        const updateInfo = await checkForUpdates(false);

        if (updateInfo.hasUpdate) {
            Logger.info(`Phát hiện phiên bản mới: ${updateInfo.localVersion} -> ${updateInfo.latestVersion}`);
            // Có thể hiển thị thông báo hoặc đánh dấu UI tại đây
            return updateInfo;
        } else {
            Logger.debug('Hiện tại đã là phiên bản mới nhất');
            return updateInfo;
        }
    } catch (e) {
        Logger.error('Khởi tạo kiểm tra cập nhật thất bại:', e);
        return null;
    }
}