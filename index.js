// index.js (Lưu trữ bằng extension_settings và bao gồm tính năng tự động di chuyển dữ liệu, tối ưu hóa quá trình khởi tạo)
import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import Logger from "./Logger.js";
// Thử import danh sách toàn cục, đường dẫn có thể cần điều chỉnh! Nếu import thất bại, logic di chuyển cần chuyển sang gọi API
import { saveSettings, saveSettingsDebounced, eventSource, event_types, getRequestHeaders, characters, scrollChatToBottom, Generate, stopGeneration, is_send_press } from "../../../../script.js";

import { groups } from "../../../group-chats.js";
import { power_user } from "../../../power-user.js";
import { getTokenCountAsync } from "../../../tokenizers.js";
import { promptManager } from "../../../openai.js";
import { checkForUpdates, getChangelog, performUpdate, initUpdateCheck } from "./update.js";

const extensionName = "hide";
const defaultSettings = {
    // Cài đặt mặc định toàn cục
    enabled: true,
    // Công tắc tổng của tính năng tự động ẩn
    autoHideEnabled: true,
    // Ghi nhận xem đã xem hướng dẫn sử dụng trang ẩn tầng lần đầu hay chưa
    hide_instructions_viewed: false,
    // Đối tượng lưu trữ cài đặt cho từng thực thể (nhân vật/nhóm)
    settings_by_entity: {},
    // Cờ đánh dấu hoàn tất di chuyển dữ liệu
    migration_v1_complete: true,
    // Thêm các trường liên quan đến cài đặt toàn cục
    useGlobalSettings: false,
    globalHideSettings: {
        hideLastN: null,
        lastProcessedLength: 0,
        userConfigured: false
    },
    // --- Cài đặt Limiter (Giới hạn tải) ---
    limiter_isEnabled: false,
    limiter_saved_count: 20, // Bản sao lưu khôi phục khi bị can thiệp trái phép
    limiter_migration_v2_complete: true,
    // --- Lưu trạng thái tab ---
    last_active_tab: 'hide-panel',
    // --- Cài đặt giao diện ---
    theme: 'light',
    // --- Cài đặt mức độ nhật ký (Log Level) ---
    logLevel: 0, // 0=Tắt log (mặc định), 1=Log cốt lõi, 2=Log hoạt động, 3=Log đầy đủ
    // --- Cài đặt gợi ý giao diện ---
    theme_notification_viewed: false, // Đã hiển thị gợi ý chuyển đổi giao diện chưa
    // --- Cài đặt hiển thị UI nhật ký ---
    logUiVisible: false, // Điều khiển hiển thị/ẩn bộ chọn mức độ log, mặc định ẩn
    logUiOpenedAt: null, // Ghi lại mốc thời gian khi UI log được mở, dùng cho cơ chế tự đóng sau 60 phút
};

// Cờ chống trùng lặp khi đồng bộ hai chiều Limiter
let _limiterSyncing = false;

// Bộ nhớ đệm ngữ cảnh (Cached context)
let cachedContext = null;

// --- Các biến cho cơ chế tạo giả lập (Dry Run) ---
let isFakeGenerating = false;
// Cờ đánh dấu: Chỉ chấp nhận kết quả quét WI để cập nhật thống kê khi plugin chủ động kích hoạt dry run
let isOurWiScan = false;

// Kích hoạt gửi giả lập để làm mới dữ liệu thống kê EJS
function forceRefreshTokenStats() {
    // Nếu đang trong quá trình tạo thực sự hoặc đang tạo giả lập, bỏ qua
    if (isFakeGenerating || is_send_press) {
        Logger.debug('Hiện đang trong quá trình tạo văn bản, bỏ qua làm mới giả lập');
        return;
    }
    isFakeGenerating = true;
    isOurWiScan = true;
    Logger.debug('Kích hoạt tạo giả lập (Dry Run) để lấy thống kê EJS mới nhất...');
    try {
        // Gọi hàm Generate tầng dưới, buộc SillyTavern tính toán toàn bộ ngữ cảnh động
        Generate('normal');
    } catch (e) {
        isFakeGenerating = false;
        isOurWiScan = false;
        Logger.error('Tạo giả lập thất bại:', e);
    }
}

// --- Lưu trữ dữ liệu thống kê trò chuyện (Token Stats) ---
let calculatedWiTokens = 0;
let wiDetailedStats = {};

// --- Bộ đánh chặn ẩn ST-PT ---
let stptInterceptedEntries = [];
let isSTPTInterceptorSetup = false;
let stptLastRunID = -1; // Ghi lại ID chu kỳ hoạt động của ST-PT

function setupSTPTInterceptor() {
    if (isSTPTInterceptorSetup) return;

    if (typeof eventSource !== 'undefined') {
        eventSource.on('prompt_template_prepare', (env) => {
            if (env && env.runType === 'generate') {
                
                // Quản lý chu kỳ: Đặt lại mảng đánh chặn khi có lượt tạo hoàn toàn mới
                if (env.runID !== undefined && env.runID !== stptLastRunID) {
                    stptInterceptedEntries = [];
                    stptLastRunID = env.runID;
                }

                // 1. Đánh chặn tầng cao nhất (như các mục tiêm @INJECT)
                if (env.world_info && env.world_info.comment) {
                    const val = env.world_info;
                    stptInterceptedEntries.push({
                        world: val.world || 'ST-PT Tiêm mặc định',
                        comment: val.comment || 'Mục chưa đặt tên',
                        rawText: val.content || '',
                        isRaw: true
                    });
                }

                // 2. Chiếm quyền điều khiển động (ví dụ getwi)
                const interceptFunction = (funcName) => {
                    if (typeof env[funcName] === 'function' && !env[funcName]._isIntercepted) {
                        const originalFunc = env[funcName];
                        
                        env[funcName] = async function(...args) {
                            const result = await originalFunc.apply(this, args);

                            if (result && typeof result === 'string' && result.trim() !== '') {
                                let bookName = '';
                                let keyword = '';

                                // Bước A: Phân tích tham số người dùng truyền vào getwi (lấy tên sách và từ khóa tìm kiếm)
                                if (args.length >= 2 && typeof args[1] !== 'object') {
                                    // Xử lý getwi(null, 'tên_mục') hoặc getwi('tên_sách', 'tên_mục')
                                    bookName = args[0] || (env.world_info && env.world_info.world) || '';
                                    keyword = String(args[1]);
                                } else if (args.length > 0) {
                                    // Xử lý getwi('tên_mục')
                                    bookName = (env.world_info && env.world_info.world) || '';
                                    keyword = String(args[0]);
                                }

                                // Tên dự phòng để tránh việc tra cứu ngược thất bại
                                let exactEntryName = `[Tìm kiếm động] ${keyword}`;
                                let finalBookName = bookName || 'Sách thế giới hiện tại';

                                // 🌟🌟🌟 Bước B: Sử dụng API gốc của ST-PT để tra cứu tên mục thực tế!
                                // env.getWorldInfoData là phương thức do ST-PT cung cấp để lấy toàn bộ mục trong World Info
                                if (typeof env.getWorldInfoData === 'function') {
                                    try {
                                        // Truyền tên sách để lấy tất cả các mục của sách đó (nếu không truyền sẽ lấy mục có hiệu lực trong môi trường hiện tại)
                                        const entries = await env.getWorldInfoData(bookName || undefined);
                                        
                                        if (Array.isArray(entries)) {
                                            // Tái hiện chính xác logic tìm kiếm của ST-PT: Khớp chính xác hoặc khớp Regex
                                            const matchedEntry = entries.find(e => {
                                                if (!e || !e.comment) return false;
                                                if (e.comment === keyword || String(e.uid) === keyword) return true;
                                                try {
                                                    // Thử khớp bằng Regex (logic gốc của ST-PT)
                                                    if (e.comment.match && e.comment.match(keyword)) return true;
                                                } catch(err) {}
                                                return false;
                                            });

                                            // Nếu tìm thấy mục thực tế, trích xuất tên thật của nó!
                                            if (matchedEntry) {
                                                exactEntryName = matchedEntry.comment;
                                                if (matchedEntry.world) {
                                                    finalBookName = matchedEntry.world;
                                                }
                                            }
                                        }
                                    } catch(e) {
                                        // Bỏ qua lỗi trong quá trình tra cứu, âm thầm quay về dùng tên dự phòng
                                        console.warn("[Trợ lý ẩn tầng] Tra cứu tên mục World Info thực tế thất bại, sử dụng từ khóa thay thế:", e);
                                    }
                                }

                                // Đẩy vào mảng thống kê (chờ ghép nối dữ liệu sau)
                                stptInterceptedEntries.push({
                                    world: finalBookName,
                                    comment: exactEntryName,
                                    rawText: result,
                                    isRaw: false
                                });
                            }
                            return result;
                        };
                        env[funcName]._isIntercepted = true;
                    }
                };

                interceptFunction('getwi');
                interceptFunction('getWorldInfo');
            }
        });
        Logger.success('Gắn bộ lắng nghe hiển thị ST-PT thành công (đã hỗ trợ tra cứu tên mục thực tế)');
    }
    isSTPTInterceptorSetup = true;
}

// Bộ nhớ đệm phần tử DOM
const domCache = {
    hideLastNInput: null,
    currentValueDisplay: null,
    // Khởi tạo bộ nhớ đệm
    init() {
        Logger.debug('Khởi tạo bộ nhớ đệm DOM...');
        this.hideLastNInput = document.getElementById('hide-last-n');
        this.currentValueDisplay = document.getElementById('hide-current-value');
        Logger.debug('Bộ nhớ đệm DOM đã khởi tạo:', {
            hideLastNInput: !!this.hideLastNInput,
            currentValueDisplay: !!this.currentValueDisplay
        });
    }
};

// --- Logic áp dụng giao diện ---
function applyTheme(theme) {
    // Đồng thời tìm popup chính, lớp phủ cập nhật, popup thông báo để gán nhãn giao diện cục bộ độc lập
    const targets = $('#hide-helper-popup, .hide-modal-overlay, #hide-helper-theme-notification');
    if (theme === 'dark') {
        targets.attr('data-theme', 'dark');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-sun"></i> Chuyển sang chế độ sáng');
    } else {
        targets.removeAttr('data-theme');
        $('#hide-helper-theme-toggle').html('<i class="fa-solid fa-moon"></i> Chuyển sang chế độ tối');
    }
}

// --- Hàm hỗ trợ popup gợi ý giao diện ---
function showThemeNotification() {
    const $notification = $('#hide-helper-theme-notification');
    if ($notification.length === 0) {
        return;
    }

    // Sử dụng hàm centerPopup để căn giữa popup
    $notification.show();
    centerPopup($notification);

    // Gắn sự kiện thay đổi kích thước cửa sổ
    $(window).off('resize.hideHelperNotification').on('resize.hideHelperNotification', () => centerPopup($notification));
}

function closeThemeNotification() {
    const $notification = $('#hide-helper-theme-notification');
    $(window).off('resize.hideHelperNotification');
    $notification.fadeOut(300, function() {
        $(this).remove();
    });
}

// --- Logic áp dụng mức độ nhật ký ---
function applyLogLevel(level) {
    Logger.setLogLevel(level);
    $('#hide-helper-log-level-select').val(level);

    // Cập nhật văn bản hiển thị mức độ nhật ký
    const levelTexts = ['Tắt log', 'Log cốt lõi', 'Log hoạt động', 'Log đầy đủ'];
    $('#hide-helper-log-level-display').text(levelTexts[level] || 'Tắt log');
}

/**
 * Hàm căn giữa popup dùng chung
 * @param {jQuery} $popup - Đối tượng jQuery của popup cần căn giữa
 */
function centerPopup($popup) {
    if (!$popup || $popup.length === 0 || $popup.is(':hidden')) {
        return;
    }

    // --- Chuyển về tính toán tọa độ căn giữa theo thời gian thực bằng JS ---
    // Khắc phục lỗi căn giữa bằng CSS trên trình duyệt di động do chiều cao khung nhìn thay đổi
    // Bằng cách lấy kích thước thực của cửa sổ trừ đi kích thước thực của popup để tính tọa độ pixel an toàn tuyệt đối

    const windowWidth = $(window).width();
    const windowHeight = $(window).height();
    const popupWidth = $popup.outerWidth();
    const popupHeight = $popup.outerHeight();

    // Tính toán động tọa độ căn giữa
    let top = (windowHeight - popupHeight) / 2;
    let left = (windowWidth - popupWidth) / 2;

    // Giới hạn biên an toàn chống tràn (giữ khoảng cách tối thiểu 10px để tránh bị tràn ra ngoài màn hình quá nhỏ)
    top = Math.max(10, top);
    left = Math.max(10, left);

    $popup.css({
        top: top + 'px',
        left: left + 'px',
        transform: 'none', // Xóa các can thiệp scale hoặc translate của CSS nếu có
        margin: '0'
    });
}

// Lấy ngữ cảnh đã được tối ưu
function getContextOptimized() {
    if (!cachedContext) {
        Logger.debug('Ngữ cảnh không có sẵn trong bộ nhớ đệm, đang lấy mới...');
        cachedContext = getContext(); // getContext trả về đối tượng giàu thông tin
        Logger.debug('Ngữ cảnh đã được lấy');
    } else {
        Logger.debug('Sử dụng ngữ cảnh từ bộ nhớ đệm');
    }
    return cachedContext;
}

// Hàm hỗ trợ: Lấy ID thực thể duy nhất của ngữ cảnh hiện tại
function getCurrentEntityId() {
    const context = getContextOptimized();
    if (!context) return null;

    if (context.groupId) {
        // Dùng tiền tố group- cùng với ID nhóm
        return `group-${context.groupId}`;
    } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const character = context.characters[context.characterId];
        // Dùng tiền tố character- cùng với tên file avatar
        if (character.avatar) {
            return `character-${character.avatar}`;
        } else {
            Logger.warn(`Không thể xác định ID thực thể nhân vật (Chỉ số ${context.characterId}): Thiếu tên file avatar`);
            return null; // Không thể xác định ID duy nhất
        }
    }
    Logger.debug('Không thể xác định ID thực thể từ ngữ cảnh');
    return null; // Không thể xác định thực thể
}

// Chạy quy trình di chuyển dữ liệu (Từ vị trí cũ sang vị trí toàn cục mới)
function runMigration() {
    Logger.info('Bắt đầu quy trình di chuyển cài đặt phiên bản cũ...');
    let migratedCount = 0;
    // Đảm bảo vùng chứa tồn tại
    extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
    const settingsContainer = extension_settings[extensionName].settings_by_entity;
    Logger.debug('Vùng chứa cài đặt đã khởi tạo');

    // --- Di chuyển dữ liệu nhân vật ---
    Logger.debug('Bắt đầu di chuyển cài đặt nhân vật');
    if (typeof characters !== 'undefined' && Array.isArray(characters)) {
        Logger.debug(`Tìm thấy ${characters.length} nhân vật`);
        characters.forEach((character, index) => {
            Logger.debug(`Đang xử lý nhân vật #${index}: ${character ? character.name : 'Không khả dụng'}`);
            if (!character || !character.data || !character.data.extensions) {
                Logger.debug(`Bỏ qua nhân vật #${index}: Thiếu thuộc tính cần thiết`);
                return;
            }
            try {
                const oldSettingsPath = 'character.data.extensions.hideHelperSettings';
                const oldSettings = character.data.extensions.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    Logger.debug(`Xác thực cài đặt cũ: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}`);
                    if (isValidOldData) {
                        const avatarFileName = character.avatar;
                        if (avatarFileName) {
                            const entityId = `character-${avatarFileName}`;
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                Logger.debug(`Di chuyển cài đặt của thực thể '${entityId}'`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                Logger.debug(`Di chuyển thực thể '${entityId}' thành công (${migratedCount})`);
                            } else {
                                Logger.debug(`Bỏ qua '${entityId}': Vị trí mới đã tồn tại dữ liệu`);
                            }
                        } else {
                             Logger.warn(`Bỏ qua di chuyển: Nhân vật ${character.name || 'Không khả dụng'} thiếu tên file avatar`);
                        }
                    } else {
                         Logger.debug(`Bỏ qua nhân vật ${character.name || 'Không khả dụng'}: Dữ liệu cài đặt cũ không hợp lệ`);
                    }
                } else {
                     Logger.debug(`Nhân vật #${index}: Không cần di chuyển`);
                }
            } catch (charError) {
                 Logger.error(`Xảy ra lỗi khi di chuyển nhân vật #${index} (${character.name || 'Không khả dụng'}):`, charError);
            }
        });
         Logger.debug('Hoàn tất di chuyển cài đặt nhân vật');
    } else {
         Logger.warn('Không thể di chuyển cài đặt nhân vật: Mảng characters không khả dụng');
    }

    // --- Di chuyển dữ liệu nhóm chat ---
    Logger.debug('Bắt đầu di chuyển cài đặt nhóm chat');
    if (typeof groups !== 'undefined' && Array.isArray(groups)) {
        Logger.debug(`Tìm thấy ${groups.length} nhóm chat`);
        groups.forEach((group, index) => {
            Logger.debug(`Đang xử lý nhóm chat #${index}: ${group ? group.name : 'Không khả dụng'} (ID: ${group ? group.id : 'Không khả dụng'})`);
             if (!group || !group.data) {
                Logger.debug(`Bỏ qua nhóm chat #${index}: Thiếu thuộc tính cần thiết`);
                return;
            }
            try {
                const oldSettingsPath = 'group.data.hideHelperSettings';
                const oldSettings = group.data.hideHelperSettings;
                if (oldSettings && typeof oldSettings === 'object' && oldSettings !== null) {
                    const hasHideLastN = typeof oldSettings.hideLastN === 'number';
                    const hasLastProcessedLength = typeof oldSettings.lastProcessedLength === 'number';
                    const isUserConfigured = oldSettings.userConfigured === true;
                    const isValidOldData = hasHideLastN || hasLastProcessedLength || isUserConfigured;
                    Logger.debug(`Xác thực cài đặt cũ: hasHideLastN=${hasHideLastN}, hasLastProcessedLength=${hasLastProcessedLength}, isUserConfigured=${isUserConfigured}`);
                    if (isValidOldData) {
                        const groupId = group.id;
                        if (groupId) {
                            const entityId = `group-${groupId}`;
                            if (!settingsContainer.hasOwnProperty(entityId)) {
                                Logger.debug(`Di chuyển cài đặt của thực thể '${entityId}'`);
                                settingsContainer[entityId] = { ...oldSettings };
                                migratedCount++;
                                Logger.debug(`Di chuyển thực thể '${entityId}' thành công (${migratedCount})`);
                            } else {
                                Logger.debug(`Bỏ qua '${entityId}': Vị trí mới đã tồn tại dữ liệu`);
                            }
                        } else {
                            Logger.warn(`Bỏ qua di chuyển: Nhóm chat ${group.name || 'Không khả dụng'} thiếu ID`);
                        }
                    } else {
                        Logger.debug(`Bỏ qua nhóm chat ${group.name || 'Không khả dụng'}: Dữ liệu cài đặt cũ không hợp lệ`);
                    }
                } else {
                     Logger.debug(`Nhóm chat #${index}: Không cần di chuyển`);
                }
            } catch (groupError) {
                Logger.error(`Xảy ra lỗi khi di chuyển nhóm chat #${index} (${group.name || 'Không khả dụng'}):`, groupError);
            }
        });
         Logger.debug('Hoàn tất di chuyển cài đặt nhóm chat');
    } else {
        Logger.warn('Không thể di chuyển cài đặt nhóm chat: Mảng groups không khả dụng');
    }

    // --- Hoàn tất di chuyển ---
     Logger.debug('Quy trình di chuyển kết thúc');
    if (migratedCount > 0) {
         Logger.success(`Di chuyển hoàn tất: Đã di chuyển thành công cài đặt của ${migratedCount} thực thể`);
    } else {
         Logger.info('Di chuyển hoàn tất: Không có cài đặt nào cần di chuyển');
    }

    // Dù có di chuyển dữ liệu hay không, đều đặt cờ thành true biểu thị đã thực hiện quy trình
    extension_settings[extensionName].migration_v1_complete = true;
    Logger.debug('Đặt cờ migration_v1_complete thành true');
    saveSettingsDebounced();
    Logger.debug('Quy trình di chuyển đã hoàn tất');
}


// Khởi tạo cài đặt tiện ích mở rộng (Bao gồm kiểm tra di chuyển dữ liệu)
function loadSettings() {
    Logger.debug('Đang tải cài đặt...');
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    // Sử dụng Object.assign để hợp nhất giá trị mặc định, đảm bảo mọi key cấp cao nhất đều tồn tại
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings, // Điền giá trị mặc định trước
        ...extension_settings[extensionName] // Sau đó ghi đè bằng các giá trị đã lưu
    });
    // Đảm bảo đối tượng lồng sâu cũng được khởi tạo đúng cách
    extension_settings[extensionName].globalHideSettings = extension_settings[extensionName].globalHideSettings || { ...defaultSettings.globalHideSettings };

    // --- Ngăn chặn settings_by_entity bị giải tuần tự hóa nhầm thành mảng (Array) ---
    // Nếu settings_by_entity là mảng, JSON.stringify khi lưu sẽ vứt bỏ toàn bộ key-value, dẫn đến mất dữ liệu sau khi khởi động lại
    if (Array.isArray(extension_settings[extensionName].settings_by_entity)) {
        Logger.warn('Phát hiện cấu trúc dữ liệu settings_by_entity bị lỗi (kiểu Array), đã cưỡng chế sửa thành Object');
        // Ép đặt lại thành đối tượng rỗng. Nếu không đặt lại, các phép gán sau đó chỉ có hiệu lực trên RAM nhưng không ghi được vào settings.json
        extension_settings[extensionName].settings_by_entity = {};
        // Kích hoạt lưu ngay lập tức để đồng bộ cấu trúc đã sửa
        saveSettingsDebounced();
    }

    extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || { ...defaultSettings.settings_by_entity };

    // --- Kiểm tra và chạy di chuyển dữ liệu ---
    if (!extension_settings[extensionName].migration_v1_complete) {
        Logger.info('Không tìm thấy cờ di chuyển, bắt đầu quy trình di chuyển...');
        try {
            runMigration();
        } catch (error) {
            Logger.error('Xảy ra lỗi khi thực hiện di chuyển dữ liệu:', error);
            // toastr.error('Xảy ra lỗi bất ngờ khi di chuyển cài đặt cũ, vui lòng kiểm tra console log.');
        }
    } else {
        Logger.debug('Cờ di chuyển là true, bỏ qua quy trình');
    }
    // --------------------------

    // --- Di chuyển Limiter v2: Từ limiter_messageLimit sang power_user.chat_truncation ---
    if (!extension_settings[extensionName].limiter_migration_v2_complete) {
        const settings = extension_settings[extensionName];
        if (typeof settings.limiter_messageLimit === 'number') {
            if (settings.limiter_isEnabled && settings.limiter_messageLimit > 0) {
                power_user.chat_truncation = settings.limiter_messageLimit;
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(settings.limiter_messageLimit);
                    $('#chat_truncation_counter').val(settings.limiter_messageLimit);
                }
                saveSettingsDebounced();
                Logger.info(`Di chuyển Limiter v2: Đã ghi limiter_messageLimit=${settings.limiter_messageLimit} vào chat_truncation`);
            }
            delete settings.limiter_messageLimit;
            Logger.info('Di chuyển Limiter v2: Đã xóa trường cũ limiter_messageLimit');
        }
        settings.limiter_migration_v2_complete = true;
        saveSettingsDebounced();
    }

    Logger.debug('Cài đặt đã được tải/khởi tạo');
}

// Tạo bảng điều khiển UI
function createUI() {
    Logger.debug('Tạo bảng điều khiển UI');
    const settingsHtml = `
    <div id="hide-helper-settings" class="hide-helper-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <div style="display:flex; align-items:center;">
                    <b>Trợ lý ẩn tầng</b>
                    <span id="hide-helper-new-badge" class="hide-new-badge" style="display: none;">NEW</span>
                </div>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <!-- Thông tin phiên bản và kiểm tra cập nhật -->
                <div class="hide-version-row">
                    <span>Phiên bản hiện tại: <span id="hide-helper-current-version">Đang tải...</span></span>
                    <button id="hide-helper-check-update-btn" class="menu_button hide-update-btn">Kiểm tra cập nhật</button>
                </div>

                <div class="hide-helper-section">
                    <!-- Tùy chọn Bật/Tắt -->
                    <div class="hide-helper-toggle-row">
                        <span class="hide-helper-label">Trạng thái tiện ích:</span>
                        <select id="hide-helper-toggle">
                            <option value="enabled">Bật</option>
                            <option value="disabled">Tắt</option>
                        </select>
                    </div>
                </div>
                <div class="hide-settings-tip">Nhấn vào nút Trợ lý ẩn tầng trong menu bên trái khung nhập chat để mở bảng điều khiển</div>
                <hr class="sysHR">
            </div>
        </div>
    </div>`;

    Logger.debug('Chèn giao diện cài đặt vào #extensions_settings');
    $("#extensions_settings").append(settingsHtml);
    createInputWandButton();
    createPopup();
    setupEventListeners();
    Logger.debug('Lên lịch khởi tạo bộ nhớ đệm DOM');
    setTimeout(() => domCache.init(), 100); // DOM cache có thể khởi tạo muộn hơn một chút
}

// Tạo nút bấm cạnh khu vực nhập chat
function createInputWandButton() {
    Logger.debug('Tạo nút khu vực nhập chat');
    // Xóa nút cũ để tránh bị trùng lặp
    $('#hide-helper-wand-button').remove();
    const buttonHtml = `
        <div id="hide-helper-wand-button" title="Mở cài đặt Trợ lý ẩn tầng">
            <i class="fa-solid fa-ghost"></i>
            <span>Trợ lý ẩn tầng</span>
        </div>`;
    Logger.debug('Chèn nút vào #data_bank_wand_container');
    $('#data_bank_wand_container').append(buttonHtml);
}

// index.js (Phần tiếp theo)

// Tạo hộp thoại popup
function createPopup() {
    Logger.debug('Tạo hộp thoại popup');
    const popupHtml = `
        <div id="hide-helper-backdrop" class="hide-helper-backdrop"></div>
        <div id="hide-helper-popup" class="hide-helper-popup">
            <button id="hide-helper-popup-close-icon" class="hide-helper-popup-close-icon">&times;</button>

            <!-- Điều hướng tab -->
            <div class="popup-tabs-nav">
                <div class="tab-button veve" data-tab="hide-panel">Ẩn tầng</div>
                <div class="tab-button" data-tab="limiter-panel">Giới hạn tải</div>
                <div class="tab-button" data-tab="token-stats-panel">Thống kê chat</div>
                <div class="tab-button" data-tab="instructions-panel">Hướng dẫn sử dụng</div>
            </div>

            <!-- Nội dung các tab -->
            <div class="popup-tabs-content">
                <!-- Panel 1: Ẩn tầng -->
                <div id="hide-panel" class="tab-panel active" data-tab="hide-panel">
                    <!-- Công tắc tổng tính năng -->
                    <div class="limiter-setting-item">
                        <label for="hide-auto-process-toggle">Bật tính năng ẩn tầng</label>
                        <div class="hide-helper-checkbox-container">
                            <input id="hide-auto-process-toggle" type="checkbox">
                            <label for="hide-auto-process-toggle"></label>
                        </div>
                    </div>

                    <div class="limiter-setting-item" id="hide-disabled-msg">
                        Tính năng ẩn tầng hiện đang bị tắt
                    </div>

                    <div id="hide-settings-wrapper">
                        <div class="hide-helper-section hide-last-n-section">
                            <label class="hide-helper-label">Giữ lại N tin nhắn mới nhất và ẩn toàn bộ các tầng cũ còn lại</label>
                            <input type="number" id="hide-last-n" min="0" placeholder="" class="hide-last-n-input">
                        </div>
                        <div class="hide-helper-current">
                            <strong id="hide-status-text">Số tầng giữ lại hiện tại:</strong>
                            <span id="hide-current-value">Không có</span>
                        </div>
                        <div class="hide-helper-mode-switch">
                            <div class="label-group">
                                <span id="hide-mode-label">Chế độ toàn cục</span>
                                <span id="hide-mode-description">Cài đặt sẽ áp dụng cho tất cả cuộc trò chuyện</span>
                            </div>
                            <label class="hide-helper-switch">
                                <input type="checkbox" id="hide-mode-toggle">
                                <span class="hide-helper-slider"></span>
                            </label>
                        </div>
                        <div class="hide-helper-popup-footer hide-helper-popup-footer-center">
                            <button id="hide-unhide-all-btn" class="hide-helper-btn">
                                <i class="fa-solid fa-eye-slash"></i> Bỏ ẩn toàn bộ các tầng trong đoạn chat hiện tại ngay lập tức
                            </button>
                        </div>

                        <!-- Khu vực giải thích chức năng -->
                        <div class="hide-panel-instructions">
                            <h3 id="hide-panel-instructions-title">Hướng dẫn sử dụng</h3>
                            <div class="instructions-content">
                                <p class="important-note"><strong>Sau khi bật tính năng ẩn tầng, SillyTavern sẽ luôn chỉ gửi N tin nhắn gần nhất tới AI, còn các tin nhắn nằm ngoài phạm vi N tầng này sẽ luôn tự động bị ẩn.</strong></p>
                                <p><strong>1. Lưu ý tiên quyết</strong></p>
                                <p>Trước khi sử dụng tính năng "Tự động ẩn", vui lòng xác nhận các cấu hình sau:</p>
                                <ul>
                                    <li><strong>Thao tác bắt buộc</strong>: Phải tích chọn <strong>【Bật tính năng ẩn tầng】</strong> và thiết lập <strong>【Số tầng giữ lại N】</strong>, nếu không tính năng sẽ không hoạt động.</li>
                                    <li><strong>Tính độc lập của chức năng</strong>: Tiện ích bao gồm 3 chức năng cốt lõi: 【Ẩn tầng】, 【Giới hạn tải】 và 【Thống kê chat】. Chúng hoạt động hoàn toàn độc lập và không ảnh hưởng lẫn nhau.</li>
                                    <li>Nếu chỉ muốn dùng 【Giới hạn tải】 và 【Thống kê chat】, bạn chỉ cần <strong>bỏ chọn</strong> 【Bật tính năng ẩn tầng】.</li>
                                </ul>

                                <p><strong>2. Hướng dẫn chi tiết</strong></p>
                                <p>Sau khi đặt số tầng giữ lại <strong>N</strong> và kích hoạt tính năng, tiện ích sẽ luôn tự động ẩn toàn bộ tin nhắn ngoài N tầng gần nhất.</p>
                                <ul>
                                    <li><strong>Ví dụ</strong>: Thiết lập giữ lại <strong>1</strong> tầng gần nhất.</li>
                                    <li><strong>Hiệu quả</strong>: Nếu hiện có từ tầng 0 đến tầng 9, tiện ích sẽ tự động ẩn từ tầng 0 đến tầng 8, chỉ gửi duy nhất tầng 9 mới nhất cho AI.</li>
                                </ul>

                                <p><strong>3. Bỏ ẩn toàn bộ các tầng trong đoạn chat hiện tại</strong></p>
                                <p>Bấm nút này sẽ thực hiện các thao tác sau:</p>
                                <ol>
                                    <li>Hủy trạng thái ẩn của tất cả tin nhắn trong đoạn chat hiện tại.</li>
                                    <li>Xóa trắng giá trị 【Số tầng giữ lại N】.</li>
                                    <li><strong>Kết quả</strong>: Tính năng tự động ẩn sẽ chuyển sang trạng thái không có hiệu lực.</li>
                                </ol>

                                <p><strong>4. Lựa chọn chế độ</strong></p>
                                <p>Tiện ích cung cấp 2 chế độ cấu hình, nên chọn tùy theo thói quen sử dụng của bạn:</p>
                                <ul>
                                    <li><strong>Chế độ toàn cục (Khuyên dùng)</strong>: Chỉ cần cài đặt 【Số tầng giữ lại】 một lần. Giá trị này sẽ áp dụng cho mọi nhân vật, đổi nhân vật không cần cấu hình lại, rất tiện lợi.</li>
                                    <li><strong>Chế độ nhân vật</strong>: Cần cấu hình riêng biệt 【Số tầng giữ lại】 cho từng thẻ nhân vật. Lưu ý: Nếu nhân vật nào chưa đặt giá trị (để trống), tính năng tự động ẩn của nhân vật đó sẽ không hoạt động.</li>
                                </ul>

                                <p><strong>5. Lưu ý và tương thích</strong></p>
                                <ul>
                                    <li><strong>Xung đột Regex</strong>: Tính năng này xung đột với "Regex ẩn tầng", vui lòng đảm bảo chỉ bật một trong hai.</li>
                                    <li><strong>Xung đột tiện ích mở rộng</strong>: Nếu có extension/script khác cũng có tính năng tự động ẩn, vui lòng chỉ bật một bên để tránh xung đột logic vận hành.</li>
                                    <li><strong>Nguyên lý cốt lõi</strong>: Trong trường hợp không có script khác can thiệp, tiện ích này đảm bảo chỉ gửi N tin nhắn gần nhất. Ngoài thao tác ẩn trực tiếp, tiện ích còn <strong>cắt trực tiếp ngữ cảnh gửi đi từ tầng dưới</strong>, đảm bảo chắc chắn số lượng tầng tin nhắn gửi đi khớp đúng với cài đặt.</li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Panel 2: Giới hạn tải -->
                <div id="limiter-panel" class="tab-panel" data-tab="limiter-panel">
                    <div class="limiter-setting-item">
                        <label for="limiter-enabled">Bật tính năng giới hạn tải</label>
                        <div class="hide-helper-checkbox-container">
                            <input id="limiter-enabled" type="checkbox">
                            <label for="limiter-enabled"></label>
                        </div>
                    </div>
                    <div class="limiter-setting-item" id="limiter-count-wrapper">
                        <label for="limiter-count">Số lượng tầng tin nhắn tải lên</label>
                        <input id="limiter-count" type="number" class="text_pole" min="0" max="1000" step="1" placeholder="Ví dụ: 20">
                    </div>
                    <div class="limiter-setting-item" id="limiter-disabled-msg">
                        Tính năng giới hạn tải hiện đang bị tắt
                    </div>
                    <div class="limiter-description">
                        Tính năng này sẽ chủ động giới hạn số lượng tin nhắn được tải và hiển thị trên giao diện chat theo thời gian thực nhằm giảm giật lag và tăng độ mượt cho SillyTavern. Khuyên bạn nên đặt 【Số lượng tầng tin nhắn tải lên】 không quá 20. Những tin nhắn không được tải lên giao diện (và chưa bị ẩn) vẫn sẽ được gửi làm ngữ cảnh cho AI bình thường. Tính năng này thực chất dùng chung API với tùy chọn gốc 【Messages to render】 của SillyTavern, do đó hoàn toàn không xung đột với tính năng giới hạn tải tin nhắn gốc hoặc của Tavern Helper / Cocktail.
                    </div>
                </div>

                <!-- Panel 3: Thống kê chat -->
                <div id="token-stats-panel" class="tab-panel" data-tab="token-stats-panel">
                    <div id="token-stats-content" class="tub-body">
                        <div class="tub-row-1" id="tub-row-overview"></div>
                        <div class="tub-row-2" id="tub-row-wi-chart"></div>
                        <div id="tub-entries-section"></div>
                    </div>
                </div>

                <!-- Panel 4: Hướng dẫn sử dụng -->
                <div id="instructions-panel" class="tab-panel" data-tab="instructions-panel">
                    <div id="hide-helper-instructions-content" class="hide-helper-instructions-content">

                        <!-- Nút chuyển đổi giao diện -->
                        <div class="theme-switch-container">
                            <span class="theme-switch-label">Giao diện UI</span>
                            <button id="hide-helper-theme-toggle" class="hide-helper-btn">
                                <i class="fa-solid fa-moon"></i> Chuyển sang chế độ tối
                            </button>
                        </div>

                        <!-- Công tắc hiển thị UI nhật ký -->
                        <div class="log-ui-toggle-container">
                            <label for="hide-helper-log-ui-toggle" class="log-ui-toggle-label">Hiển thị nhật ký (Log)</label>
                            <div style="display: flex; align-items: center;">
                                <i class="fa-solid fa-download" id="hide-helper-download-log" title="Tải xuống nhật ký gỡ lỗi" style="cursor: pointer; margin-right: 12px; font-size: 16px; color: var(--hh-text-secondary); display: none; transition: color 0.2s;"></i>
                                <div class="hide-helper-checkbox-container">
                                    <input id="hide-helper-log-ui-toggle" type="checkbox">
                                    <label for="hide-helper-log-ui-toggle"></label>
                                </div>
                            </div>
                        </div>

                        <!-- Bộ chọn mức độ nhật ký (Mặc định ẩn) -->
                        <div class="log-level-selector-wrapper" style="display: none;">
                        <div class="log-level-switch-container">
                            <span class="log-level-label">Mức độ log</span>
                            <select id="hide-helper-log-level-select" class="hide-helper-select log-level-select">
                                <option value="0">Tắt log (Không xuất log)</option>
                                <option value="1">Log cốt lõi (Lỗi + Cảnh báo)</option>
                                <option value="2">Log hoạt động (Toàn bộ thông tin chạy)</option>
                                <option value="3">Log đầy đủ (Bao gồm debug)</option>
                            </select>
                        </div>
                        </div>

                        <video class="instructions-video" controls muted loop playsinline>
                            <source src="https://files.catbox.moe/wmv5bd.mp4" type="video/mp4">
                            Trình duyệt của bạn không hỗ trợ thẻ Video.
                        </video>

                        <h2>Sự phối hợp và khác biệt giữa các tính năng cốt lõi</h2>
                        <p><strong>Ẩn tầng</strong> và <strong>Giới hạn tải</strong> là hai tính năng có thể cấu hình độc lập và phối hợp nhịp nhàng với nhau để giải quyết các vấn đề khác nhau (có thể dùng kết hợp):</p>
                        <ul>
                            <li><strong>Ẩn tầng (Tiết kiệm Token):</strong> Tính năng này sẽ trực tiếp ẩn tin nhắn, các tin nhắn bị ẩn sẽ xuất hiện biểu tượng bóng ma 👻. Tin nhắn bị ẩn <strong>sẽ KHÔNG</strong> được gửi tới AI.</li>
                            <li><strong>Giới hạn tải (Tăng độ mượt):</strong> Tính năng này không sửa đổi bất kỳ dữ liệu nào, nó chỉ giới hạn số lượng tin nhắn được tải và hiển thị trên giao diện chat <strong>về mặt thị giác</strong>. Tất cả tin nhắn chưa bị ẩn vẫn sẽ được gửi tới AI như thường, chỉ là chúng không được render ở frontend. Điều này giúp tăng hiệu năng rõ rệt cho các đoạn chat siêu dài và giảm giật lag.</li>
                            <li><strong>Lưu ý:</strong> Từ "Ẩn" trong SillyTavern là chỉ: Tin nhắn có xuất hiện biểu tượng bóng ma 👻. Loại tin nhắn này sẽ không làm ngữ cảnh gửi cho AI. Còn tin nhắn "chưa được tải" chỉ là giao diện chưa render ra, không có nghĩa là nó không được gửi cho AI. Việc có gửi cho AI hay không phụ thuộc vào việc nó có bị "ẩn" hay không, chứ không phụ thuộc vào việc nó có hiển thị trên màn hình hay không.</li>
                        </ul>

                        <h2>Ẩn tầng (Tính năng 1)</h2>
                        <p>
                           Cốt lõi của tính năng này là: Mỗi lần tương tác với AI, chỉ gửi N tin nhắn mới nhất làm ngữ cảnh và tự động ẩn toàn bộ các tin nhắn cũ trước đó.
                        </p>
                        <p class="important">
                            <i class="fa-solid fa-shield-halved"></i> <strong>Cơ chế bảo vệ kép:</strong> Tiện ích sử dụng đồng thời hai phương thức "Ẩn tin nhắn" và "Đánh chặn yêu cầu" để đảm bảo các tin cũ không bao giờ bị gửi cho AI. Ngay cả khi một số tầng tin nhắn không kích hoạt ẩn thành công do lý do đặc biệt (chẳng hạn bị tính năng ẩn của plugin/script khác ghi đè), cơ chế đánh chặn vẫn sẽ cưỡng chế cắt ngắn danh sách tin nhắn trước khi gửi request API đi, đóng vai trò như chốt chặn cuối cùng bảo đảm số tin nhắn thực sự gửi đi chỉ vỏn vẹn N tầng gần nhất.
                        </p>
                        <p>
                            Điền <strong>số lượng tin nhắn mới nhất bạn muốn giữ lại</strong> vào ô nhập liệu (ví dụ <code>4</code>), sau đó nhấn nút <span class="button-like">Lưu cài đặt</span>. Tiện ích sẽ có hiệu lực ngay lập tức, ẩn toàn bộ nội dung nằm ngoài phạm vi thiết lập.
                        </p>
                        <p>
                            <strong>Ví dụ:</strong> Giả sử đoạn chat hiện có 10 tin nhắn. Bạn nhập <code>4</code> và lưu, thì 4 tin mới nhất sẽ được gửi cho AI, còn 6 tin trước đó sẽ không gửi cho AI. Khi bạn hoặc AI gửi tin nhắn mới, tiện ích sẽ tự động điều chỉnh để luôn đảm bảo chỉ có 4 tin mới nhất là không bị ẩn, còn các tin cũ trước đó luôn trong trạng thái ẩn.
                        </p>
                        <h3>Chế độ toàn cục vs Chế độ nhân vật</h3>
                        <p>
                            Bạn có thể chuyển đổi linh hoạt giữa hai chế độ thông qua <strong>công tắc gạt</strong> trong popup:
                            <ul>
                                <li><strong>Chế độ toàn cục:</strong> Ở chế độ này, số lượng giữ lại bạn thiết lập sẽ áp dụng cho <strong>TẤT CẢ</strong> thẻ nhân vật và nhóm chat. Cài đặt một lần, áp dụng mọi nơi.</li>
                                <li><strong>Chế độ nhân vật:</strong> Ở chế độ này, cài đặt sẽ <strong>CHỈ</strong> gắn liền với nhân vật hiện tại. Bạn có thể đặt và lưu một số lượng giữ lại riêng biệt cho từng nhân vật hoặc nhóm chat.</li>
                            </ul>
                        </p>
                         <h3>Hủy bỏ ẩn</h3>
                         <p>
                            Sau khi nhấn nút <span class="button-like">Bỏ ẩn</span>, tiện ích sẽ ngay lập tức bỏ ẩn toàn bộ các tầng trong đoạn chat hiện tại, đồng thời xóa trống giá trị N giữ lại. Ở trạng thái để trống, tính năng tự động ẩn sẽ không có hiệu lực.
                        </p>
                        <p class="important">
                            <i class="fa-solid fa-circle-info"></i> Tin nhắn bị ẩn <strong>sẽ KHÔNG</strong> được đưa vào ngữ cảnh gửi tới AI. Điều này đồng nghĩa với việc AI không thể "nhìn thấy" các tin nhắn trước N tầng này, điều này cực kỳ hữu ích để kiểm soát độ dài ngữ cảnh và tiết kiệm Token.
                        </p>

                        <h2>Giới hạn tải (Tính năng 2)</h2>
                        <p>
                            Tính năng này tối ưu hóa trải nghiệm xem các cuộc trò chuyện siêu dài bằng cách điều khiển tùy chọn "Số tin nhắn tải" gốc của SillyTavern. Nó chỉ ảnh hưởng đến số lượng tin nhắn được <strong>【Hiển thị】</strong> trên giao diện chat SillyTavern, hoàn toàn không sửa đổi dữ liệu chat hay ảnh hưởng tới ngữ cảnh gửi cho AI. Do hạn chế số lượng phần tử render trên giao diện, tính năng này giảm giật lag cực kỳ hiệu quả, đặc biệt là với các đoạn chat lên đến hàng ngàn tin nhắn.
                        </p>
                        <p>
                            Sau khi bật, bạn có thể chỉnh giá trị tại đây hoặc tại mục "Messages to render" trong bảng "Cài đặt người dùng" của SillyTavern, hai bên sẽ tự động đồng bộ với nhau. Đặt thành <code>0</code> biểu thị không giới hạn (tải toàn bộ tin nhắn).
                        </p>
                        <p>
                           <strong>Ví dụ:</strong> Bạn đặt tải <code>20</code> tin nhắn. Kể cả đoạn chat có 1000 tin, cửa sổ chat cũng chỉ tải và hiển thị 20 tin cuối cùng. Nếu cần xem các tin trước đó, bạn có thể nhấn nút "Show more messages" ở phía trên cùng của khung chat.
                        </p>
                    </div>
                </div>
            </div>
        </div>`;
    Logger.debug('Chèn HTML popup vào body');
    $('body').append(popupHtml);

    // Thêm lớp phủ (overlay) cho modal cập nhật
    const overlayHtml = `<div id="hide-helper-modal-overlay" class="hide-modal-overlay"></div>`;
    if ($('#hide-helper-modal-overlay').length === 0) {
        $('body').append(overlayHtml);
    }

    // Thêm HTML popup gợi ý giao diện (nếu cần hiển thị)
    if (!extension_settings[extensionName].theme_notification_viewed) {
        const notificationHtml = `
            <div id="hide-helper-theme-notification" class="hide-helper-notification-popup">
                <div class="notification-content">
                    <div class="notification-icon">
                        <i class="fa-solid fa-moon"></i>
                    </div>
                    <h3>Tiện ích hiện đã hỗ trợ 2 bộ giao diện Sáng / Tối</h3>
                    <p>Bạn có thể chuyển đổi trong trang 【Hướng dẫn sử dụng】.</p>
                    <div class="notification-buttons">
                        <button id="hide-helper-switch-theme-now" class="hide-helper-btn notification-primary-btn">
                            <i class="fa-solid fa-moon"></i> Chuyển sang giao diện Tối ngay
                        </button>
                        <button id="hide-helper-notification-close" class="hide-helper-btn notification-secondary-btn">
                            Đã hiểu
                        </button>
                    </div>
                </div>
            </div>`;
        $('body').append(notificationHtml);
    }
}

// Lấy cài đặt ẩn hiện tại cần áp dụng (Đọc từ extension_settings toàn cục)
function getCurrentHideSettings() {
    Logger.debug('Lấy cài đặt ẩn hiện tại');
    // Kiểm tra xem có dùng cài đặt toàn cục không
    if (extension_settings[extensionName]?.useGlobalSettings) {
        Logger.debug('Sử dụng cài đặt toàn cục');
        return extension_settings[extensionName]?.globalHideSettings || null;
    }

    // Sử dụng cài đặt của thực thể cụ thể
    const entityId = getCurrentEntityId();
    if (!entityId) {
        Logger.debug('Không thể xác định ID thực thể');
        return null;
    }
    const settings = extension_settings[extensionName]?.settings_by_entity?.[entityId] || null;
    Logger.debug(`Đọc cài đặt của thực thể "${entityId}":`, settings);
    return settings;
}

// Lưu cài đặt ẩn hiện tại (Vào extension_settings toàn cục)
function saveCurrentHideSettings(hideLastN) {
    Logger.debug('');
    Logger.debug('💾💾💾【Lưu cài đặt ẩn】Bắt đầu 💾💾💾');

    const context = getContextOptimized();
    if (!context) {
        Logger.error('【Lưu cài đặt ẩn】❌ Không thể lưu cài đặt: Ngữ cảnh không khả dụng');
        Logger.debug('💾💾💾【Lưu cài đặt ẩn】Kết thúc (Thất bại) 💾💾💾');
        Logger.debug('');
        return false;
    }

    const chatLength = context.chat?.length || 0;
    const settings = extension_settings[extensionName];
    const useGlobalSettings = settings?.useGlobalSettings || false;
    const entityId = getCurrentEntityId();

    Logger.debug(`【Lưu cài đặt ẩn】📊 Tham số lưu:`);
    Logger.debug(`【Lưu cài đặt ẩn】   - hideLastN: ${hideLastN}`);
    Logger.debug(`【Lưu cài đặt ẩn】   - Độ dài chat hiện tại: ${chatLength}`);
    Logger.debug(`【Lưu cài đặt ẩn】   - Sử dụng chế độ toàn cục: ${useGlobalSettings}`);
    Logger.debug(`【Lưu cài đặt ẩn】   - ID thực thể: ${entityId || 'Không thể xác định'}`);

    const settingsToSave = {
        hideLastN: (hideLastN !== null && hideLastN > 0) ? hideLastN : null,
        lastProcessedLength: chatLength,
        userConfigured: true
    };

    extension_settings[extensionName] = extension_settings[extensionName] || {};

    if (useGlobalSettings) {
        Logger.debug(`【Lưu cài đặt ẩn】💾 Lưu vào 【Cài đặt toàn cục】`);
        extension_settings[extensionName].globalHideSettings = settingsToSave;
        Logger.debug(`【Lưu cài đặt ẩn】✅ Cài đặt toàn cục đã cập nhật:`, settingsToSave);
    } else {
        if (!entityId) {
            Logger.error('【Lưu cài đặt ẩn】❌ Không thể lưu cài đặt: Không xác định được ID thực thể');
            toastr.error('Không thể lưu cài đặt: Không xác định được nhân vật hoặc nhóm hiện tại.');
            Logger.debug('💾💾💾【Lưu cài đặt ẩn】Kết thúc (Thất bại) 💾💾💾');
            Logger.debug('');
            return false;
        }
        Logger.debug(`【Lưu cài đặt ẩn】💾 Lưu vào 【Cài đặt thực thể】: ${entityId}`);
        extension_settings[extensionName].settings_by_entity = extension_settings[extensionName].settings_by_entity || {};
        extension_settings[extensionName].settings_by_entity[entityId] = settingsToSave;
        Logger.debug(`【Lưu cài đặt ẩn】✅ Cài đặt thực thể đã cập nhật:`, settingsToSave);
    }

    saveSettingsDebounced();
    Logger.debug(`【Lưu cài đặt ẩn】✅ Đã gọi saveSettingsDebounced()`);
    Logger.debug(`【Lưu cài đặt ẩn】✨ Cài đặt đã lưu: N=${hideLastN}, Chế độ=${useGlobalSettings ? 'Toàn cục' : 'Thực thể'}`);
    Logger.debug('💾💾💾【Lưu cài đặt ẩn】Kết thúc 💾💾💾');
    Logger.debug('');
    return true;
}

// Cập nhật giao diện hiển thị cài đặt hiện tại
function updateCurrentHideSettingsDisplay() {
    Logger.debug('Cập nhật hiển thị cài đặt ẩn');

    const settings = extension_settings[extensionName];
    const currentHideSettings = getCurrentHideSettings();
    const $statusText = $('#hide-status-text');
    const $valueDisplay = $('#hide-current-value');
    const $input = $('#hide-last-n');

    // Cập nhật trạng thái công tắc tổng
    const autoHideEnabled = settings.autoHideEnabled ?? true;
    $('#hide-auto-process-toggle').prop('checked', autoHideEnabled);

    // Ẩn/hiện ô nhập và thông báo theo trạng thái công tắc
    if (autoHideEnabled) {
        $('#hide-settings-wrapper').show();
        $('#hide-disabled-msg').hide();
    } else {
        $('#hide-settings-wrapper').hide();
        $('#hide-disabled-msg').show();
    }

    // Nội dung văn bản theo logic trạng thái
    if (!autoHideEnabled) {
        $statusText.text("Tính năng tự động ẩn tầng đã bị tắt");
        $valueDisplay.text("");
    } else if (!currentHideSettings?.hideLastN || currentHideSettings.hideLastN <= 0) {
        $statusText.text("Chưa thiết lập giá trị N giữ lại, tự động ẩn chưa có hiệu lực");
        $valueDisplay.text("");
    } else {
        $statusText.text("Số tầng giữ lại hiện tại:");
        $valueDisplay.text(currentHideSettings.hideLastN);
    }

    // Cập nhật ô nhập (0 hoặc rỗng đều hiển thị trống)
    $input.val(currentHideSettings?.hideLastN > 0 ? currentHideSettings.hideLastN : '');

    // Cập nhật UI chuyển đổi chế độ
    const useGlobal = extension_settings[extensionName]?.useGlobalSettings || false;
    $('#hide-mode-toggle').prop('checked', useGlobal);
    $('#hide-mode-label').text(useGlobal ? 'Chế độ toàn cục' : 'Chế độ nhân vật');
    $('#hide-mode-description').text(useGlobal ? 'Ẩn sẽ áp dụng cho tất cả thẻ nhân vật' : 'Ẩn chỉ áp dụng cho thẻ nhân vật hiện tại');

	// --- Cập nhật Panel Limiter ---
    // Ưu tiên đọc từ biến bóng (shadow variable) của plugin (để chống can thiệp trái phép), kế tiếp đọc tầng dưới, cuối cùng đọc DOM
    let nativeTruncation = extension_settings[extensionName].limiter_saved_count;
    if (!nativeTruncation || nativeTruncation <= 0) {
        nativeTruncation = power_user.chat_truncation;
        if (typeof nativeTruncation !== 'number' || isNaN(nativeTruncation) || nativeTruncation <= 0) {
            nativeTruncation = Number($('#chat_truncation').val()) || 0;
        }
    }

    const isLimiterEnabled = extension_settings[extensionName].limiter_isEnabled;
    $('#limiter-enabled').prop('checked', isLimiterEnabled);
    // Nếu có giá trị hợp lệ thì hiển thị, nếu bằng 0 đặt thành chuỗi rỗng để hiển thị placeholder
    $('#limiter-count').val(nativeTruncation > 0 ? nativeTruncation : '');

    // Ẩn/hiện ô nhập và thông báo theo trạng thái công tắc Limiter
    if (isLimiterEnabled) {
        $('#limiter-count-wrapper').show();
        $('#limiter-disabled-msg').hide();
    } else {
        $('#limiter-count-wrapper').hide();
        $('#limiter-disabled-msg').show();
    }

    Logger.debug('Hoàn tất cập nhật hiển thị cài đặt ẩn');
}

// Hàm chống rung (debounce)
function debounce(fn, delay) {
    let timer;
    return function(...args) {
        Logger.debug(`Chống rung (debounce): Xóa hẹn giờ của ${fn.name}`);
        clearTimeout(timer);
        Logger.debug(`Chống rung (debounce): Đặt hẹn giờ ${delay}ms cho ${fn.name}`);
        timer = setTimeout(() => {
            Logger.debug(`Chống rung (debounce): Thực thi ${fn.name}`);
            fn.apply(this, args);
        }, delay);
    };
}


// Bản chống rung cho kiểm tra toàn lượng
const runFullHideCheckDebounced = debounce(runFullHideCheck, 200);

// Bản chống rung tự động lưu cài đặt
const saveSettingsAutoDebounced = debounce(() => {
    const val = parseInt($('#hide-last-n').val());
    if (val > 0) {
        saveCurrentHideSettings(val);
        runFullHideCheckDebounced();
        updateCurrentHideSettingsDisplay();
    } else if (val === 0) {
        unhideAllMessages(true);
    } else {
        // Nhập giá trị rỗng
        saveCurrentHideSettings(null);
        updateCurrentHideSettingsDisplay();
    }
}, 800);

// Kiểm tra xem có nên thực hiện thao tác ẩn/bỏ ẩn hay không
function shouldProcessHiding() {
    Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Logger.debug('【Kiểm tra ẩn】Bắt đầu xác định xem có nên xử lý ẩn hay không');

    const mainEnabled = extension_settings[extensionName]?.enabled; // Công tắc tổng tiện ích
    const autoHideEnabled = extension_settings[extensionName]?.autoHideEnabled ?? true; // Công tắc tính năng tự động ẩn

    Logger.debug(`【Kiểm tra ẩn】Trạng thái công tắc tổng tiện ích: mainEnabled=${mainEnabled}`);
    Logger.debug(`【Kiểm tra ẩn】Trạng thái tính năng tự động ẩn: autoHideEnabled=${autoHideEnabled}`);

    if (!mainEnabled || !autoHideEnabled) {
        Logger.debug(`【Kiểm tra ẩn】❌ Tiện ích hoặc tính năng tự động ẩn đã bị tắt, trả về false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }

    const settings = getCurrentHideSettings();
    Logger.debug(`【Kiểm tra ẩn】Cài đặt thực thể hiện tại:`, {
        exists: !!settings,
        userConfigured: settings?.userConfigured,
        hideLastN: settings?.hideLastN,
        lastProcessedLength: settings?.lastProcessedLength
    });

    // Nếu chưa cấu hình, hoặc hideLastN là null/undefined/NaN/0 thì không xử lý tự động ẩn
    if (!settings) {
        Logger.debug(`【Kiểm tra ẩn】❌ Đối tượng cài đặt không tồn tại, trả về false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }
    if (!settings.userConfigured) {
        Logger.debug(`【Kiểm tra ẩn】❌ Người dùng chưa cấu hình (userConfigured=false), trả về false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }
    if (!settings.hideLastN || settings.hideLastN <= 0) {
        Logger.debug(`【Kiểm tra ẩn】❌ Giá trị ẩn không hợp lệ (hideLastN=${settings.hideLastN}), trả về false`);
        Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        return false;
    }

    Logger.debug(`【Kiểm tra ẩn】✅ Mọi kiểm tra đã thông qua, sẽ thực hiện thao tác ẩn, giữ lại ${settings.hideLastN} tin nhắn mới nhất`);
    Logger.debug('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return true;
}

// Kiểm tra ẩn tăng dần (Incremental Check)
async function runIncrementalHideCheck() {
    Logger.debug('');
    Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Bắt đầu 🔄🔄🔄');

    if (!shouldProcessHiding()) {
        Logger.debug('【Kiểm tra ẩn tăng dần】⛔ shouldProcessHiding trả về false, bỏ qua kiểm tra tăng dần');
        Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Kết thúc (Bỏ qua) 🔄🔄🔄');
        Logger.debug('');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('【Kiểm tra ẩn tăng dần】⛔ Ngữ cảnh hoặc dữ liệu chat không khả dụng, hủy bỏ');
        Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Kết thúc (Dữ liệu không khả dụng) 🔄🔄🔄');
        Logger.debug('');
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength = 0 } = settings;

    Logger.debug(`【Kiểm tra ẩn tăng dần】📊 Trạng thái hiện tại:`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Độ dài chat hiện tại: ${currentChatLength}`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Số tầng giữ lại N: ${hideLastN}`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Độ dài xử lý lần trước: ${lastProcessedLength}`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Người dùng đã cấu hình: ${settings.userConfigured}`);

    if (currentChatLength === 0 || hideLastN <= 0) {
        Logger.debug(`【Kiểm tra ẩn tăng dần】⛔ Chat rỗng hoặc giá trị N không hợp lệ, bỏ qua`);
        if (currentChatLength !== lastProcessedLength && settings.userConfigured) {
            Logger.debug(`【Kiểm tra ẩn tăng dần】💾 Độ dài thay đổi (${lastProcessedLength} -> ${currentChatLength}), lưu cài đặt`);
            saveCurrentHideSettings(hideLastN);
        }
        Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Kết thúc (Chat rỗng hoặc N không hợp lệ) 🔄🔄🔄');
        Logger.debug('');
        return;
    }

    if (currentChatLength <= lastProcessedLength) {
        Logger.debug(`【Kiểm tra ẩn tăng dần】⛔ Độ dài chat không tăng (${lastProcessedLength} -> ${currentChatLength}), bỏ qua xử lý tăng dần`);
        if (currentChatLength < lastProcessedLength && settings.userConfigured) {
            Logger.debug(`【Kiểm tra ẩn tăng dần】💾 Độ dài chat giảm đi, lưu cài đặt`);
            saveCurrentHideSettings(hideLastN);
        }
        Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Kết thúc (Độ dài không tăng) 🔄🔄🔄');
        Logger.debug('');
        return;
    }

    // Tính toán phạm vi hiển thị
    const targetVisibleStart = Math.max(0, currentChatLength - hideLastN);
    const previousVisibleStart = lastProcessedLength > 0 ? Math.max(0, lastProcessedLength - hideLastN) : 0;

    Logger.debug(`【Kiểm tra ẩn tăng dần】📐 Tính toán phạm vi hiển thị:`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Điểm bắt đầu hiển thị mục tiêu: ${targetVisibleStart} (Tin nhắn có index >= ${targetVisibleStart} sẽ hiển thị)`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Điểm bắt đầu hiển thị lần trước: ${previousVisibleStart}`);
    Logger.debug(`【Kiểm tra ẩn tăng dần】   - Phạm vi index cần kiểm tra: [${previousVisibleStart}, ${targetVisibleStart})`);

    if (targetVisibleStart > previousVisibleStart) {
        const toHideIncrementally = [];
        const startIndex = previousVisibleStart;
        const endIndex = targetVisibleStart;

        Logger.debug(`【Kiểm tra ẩn tăng dần】🔍 Đang quét tin nhắn [${startIndex}, ${endIndex})...`);

        for (let i = startIndex; i < endIndex; i++) {
            if (chat[i]) {
                if (chat[i].is_system !== true) {
                    toHideIncrementally.push(i);
                    Logger.debug(`【Kiểm tra ẩn tăng dần】   ✋ Tin nhắn #${i} đánh dấu là ẩn (is_system: false -> true)`);
                } else {
                    Logger.debug(`【Kiểm tra ẩn tăng dần】   ⏭️  Tin nhắn #${i} đã ở trạng thái ẩn, bỏ qua`);
                }
            } else {
                Logger.debug(`【Kiểm tra ẩn tăng dần】   ❌ Tin nhắn #${i} không tồn tại, bỏ qua`);
            }
        }

        if (toHideIncrementally.length > 0) {
            Logger.debug(`【Kiểm tra ẩn tăng dần】🎯 Chuẩn bị ẩn ${toHideIncrementally.length} tin nhắn: [${toHideIncrementally.join(', ')}]`);

            // Cập nhật dữ liệu
            toHideIncrementally.forEach(idx => {
                if (chat[idx]) {
                    chat[idx].is_system = true;
                }
            });
            Logger.debug(`【Kiểm tra ẩn tăng dần】✅ Dữ liệu mảng chat đã cập nhật`);

            // Cập nhật DOM
            try {
                const hideSelector = toHideIncrementally.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                    Logger.debug(`【Kiểm tra ẩn tăng dần】✅ Cập nhật DOM hoàn tất: ${hideSelector}`);
                }
            } catch (error) {
                Logger.error('【Kiểm tra ẩn tăng dần】❌ Cập nhật DOM thất bại:', error);
            }

            Logger.debug(`【Kiểm tra ẩn tăng dần】💾 Lưu cài đặt`);
            saveCurrentHideSettings(hideLastN);

            const elapsed = (performance.now() - startTime).toFixed(2);
            Logger.debug(`【Kiểm tra ẩn tăng dần】✨ Ẩn tăng dần hoàn tất! Đã ẩn ${toHideIncrementally.length} tin nhắn, tốn ${elapsed}ms`);

        } else {
            Logger.debug(`【Kiểm tra ẩn tăng dần】ℹ️  Không có tin nhắn nào trong phạm vi cần ẩn`);
            if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
                Logger.debug(`【Kiểm tra ẩn tăng dần】💾 Lưu cài đặt`);
                saveCurrentHideSettings(hideLastN);
            }
        }
    } else {
        Logger.debug(`【Kiểm tra ẩn tăng dần】ℹ️  Điểm bắt đầu hiển thị không tiến thêm (targetVisibleStart=${targetVisibleStart} <= previousVisibleStart=${previousVisibleStart})`);
        if (settings.lastProcessedLength !== currentChatLength && settings.userConfigured) {
            Logger.debug(`【Kiểm tra ẩn tăng dần】💾 Lưu cài đặt`);
            saveCurrentHideSettings(hideLastN);
        }
    }

    Logger.debug('🔄🔄🔄【Kiểm tra ẩn tăng dần】Kết thúc 🔄🔄🔄');
    Logger.debug('');
}

// Kiểm tra ẩn toàn lượng (Full Check)
async function runFullHideCheck() {
    Logger.debug('');
    Logger.debug('🔍🔍🔍【Kiểm tra ẩn toàn lượng】Bắt đầu 🔍🔍🔍');

    if (!shouldProcessHiding()) {
        Logger.debug('【Kiểm tra ẩn toàn lượng】⛔ shouldProcessHiding trả về false, bỏ qua kiểm tra toàn lượng');
        Logger.debug('🔍🔍🔍【Kiểm tra ẩn toàn lượng】Kết thúc (Bỏ qua) 🔍🔍🔍');
        Logger.debug('');
        return;
    }

    const startTime = performance.now();
    const context = getContextOptimized();
    if (!context || !context.chat) {
        Logger.debug('【Kiểm tra ẩn toàn lượng】⛔ Ngữ cảnh hoặc dữ liệu chat không khả dụng, hủy bỏ');
        Logger.debug('🔍🔍🔍【Kiểm tra ẩn toàn lượng】Kết thúc (Dữ liệu không khả dụng) 🔍🔍🔍');
        Logger.debug('');
        return;
    }

    const chat = context.chat;
    const currentChatLength = chat.length;
    Logger.debug(`【Kiểm tra ẩn toàn lượng】📊 Độ dài chat hiện tại: ${currentChatLength}`);

    const settings = getCurrentHideSettings() || { hideLastN: 0, lastProcessedLength: 0, userConfigured: false };
    const { hideLastN, lastProcessedLength, userConfigured } = settings;

    Logger.debug(`【Kiểm tra ẩn toàn lượng】📋 Thông tin cấu hình:`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Số tầng giữ lại N: ${hideLastN}`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Người dùng đã cấu hình: ${userConfigured}`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Độ dài xử lý lần trước: ${lastProcessedLength}`);

    // Tính toán điểm bắt đầu hiển thị
    const visibleStart = hideLastN <= 0
        ? 0
        : (hideLastN >= currentChatLength
            ? 0
            : Math.max(0, currentChatLength - hideLastN));

    Logger.debug(`【Kiểm tra ẩn toàn lượng】📐 Tính toán phạm vi hiển thị:`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Index bắt đầu hiển thị: ${visibleStart}`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Phạm vi tin nhắn hiển thị: [${visibleStart}, ${currentChatLength}) (Tổng cộng ${currentChatLength - visibleStart} tin)`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Phạm vi tin nhắn ẩn: [0, ${visibleStart}) (Tổng cộng ${visibleStart} tin)`);

    const toHide = [];
    const toShow = [];
    let changed = false;

    Logger.debug(`【Kiểm tra ẩn toàn lượng】🔍 Bắt đầu quét toàn bộ ${currentChatLength} tin nhắn...`);

    for (let i = 0; i < currentChatLength; i++) {
        const msg = chat[i];
        if (!msg) {
            Logger.debug(`【Kiểm tra ẩn toàn lượng】   ⚠️  Index ${i}: Tin nhắn rỗng, bỏ qua`);
            continue;
        }

        const isCurrentlyHidden = msg.is_system === true;
        const shouldBeHidden = i < visibleStart;

        if (shouldBeHidden && !isCurrentlyHidden) {
            // Nên ẩn nhưng hiện chưa ẩn → Cần ẩn
            msg.is_system = true;
            toHide.push(i);
            changed = true;
            Logger.debug(`【Kiểm tra ẩn toàn lượng】   ✋ Index ${i}: Ẩn (is_system: false -> true)`);
        } else if (!shouldBeHidden && isCurrentlyHidden) {
            // Nên hiển thị nhưng hiện đang ẩn → Cần hiển thị
            msg.is_system = false;
            toShow.push(i);
            changed = true;
            Logger.debug(`【Kiểm tra ẩn toàn lượng】   👁️  Index ${i}: Hiển thị (is_system: true -> false)`);
        } else {
            // Trạng thái đã chuẩn, không cần thay đổi
            const status = isCurrentlyHidden ? 'Đã ẩn' : 'Đang hiển thị';
            Logger.debug(`【Kiểm tra ẩn toàn lượng】   ✓  Index ${i}: ${status} (Không cần đổi)`);
        }
    }

    Logger.debug(`【Kiểm tra ẩn toàn lượng】📊 Kết quả tính toán chênh lệch:`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Cần ẩn: ${toHide.length} tin [${toHide.join(', ') || 'Không có'}]`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Cần hiển thị: ${toShow.length} tin [${toShow.join(', ') || 'Không có'}]`);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】   - Có thay đổi hay không: ${changed}`);

    if (changed) {
        try {
            Logger.debug(`【Kiểm tra ẩn toàn lượng】🔄 Bắt đầu áp dụng cập nhật DOM...`);

            if (toHide.length > 0) {
                const hideSelector = toHide.map(id => `.mes[mesid="${id}"]`).join(',');
                if (hideSelector) {
                    $(hideSelector).attr('is_system', 'true');
                    Logger.debug(`【Kiểm tra ẩn toàn lượng】   ✅ Ẩn phần tử DOM: ${hideSelector}`);
                }
            }

            if (toShow.length > 0) {
                const showSelector = toShow.map(id => `.mes[mesid="${id}"]`).join(',');
                if (showSelector) {
                    $(showSelector).attr('is_system', 'false');
                    Logger.debug(`【Kiểm tra ẩn toàn lượng】   ✅ Hiển thị phần tử DOM: ${showSelector}`);
                }
            }

            Logger.debug(`【Kiểm tra ẩn toàn lượng】✅ Cập nhật DOM hoàn tất`);
        } catch (error) {
            Logger.error('【Kiểm tra ẩn toàn lượng】❌ Lỗi bất thường khi cập nhật DOM:', error);
        }
    } else {
        Logger.debug(`【Kiểm tra ẩn toàn lượng】ℹ️  Không cần thay đổi dữ liệu chat hay DOM`);
    }

    // Lưu cài đặt
    if (userConfigured && lastProcessedLength !== currentChatLength) {
        Logger.debug(`【Kiểm tra ẩn toàn lượng】💾 Độ dài thay đổi (${lastProcessedLength} -> ${currentChatLength}), lưu cài đặt`);
        saveCurrentHideSettings(hideLastN);
    } else {
        Logger.debug(`【Kiểm tra ẩn toàn lượng】ℹ️  Không cần lưu cài đặt`);
    }

    const elapsed = (performance.now() - startTime).toFixed(2);
    Logger.debug(`【Kiểm tra ẩn toàn lượng】✨ Kiểm tra toàn lượng hoàn tất! Ẩn: ${toHide.length}, Hiển thị: ${toShow.length}, tốn: ${elapsed}ms`);
    Logger.debug('🔍🔍🔍【Kiểm tra ẩn toàn lượng】Kết thúc 🔍🔍🔍');
    Logger.debug('');
}

// Tính năng bỏ ẩn toàn bộ
async function unhideAllMessages(isFromInputZero = false) {
    Logger.debug('');
    Logger.debug('👁️👁️👁️【Bỏ ẩn toàn bộ】Bắt đầu 👁️👁️👁️');

    const startTime = performance.now();
    const context = getContextOptimized();

    Logger.debug(`【Bỏ ẩn toàn bộ】Cách thức kích hoạt: ${isFromInputZero ? 'Giá trị nhập đặt về 0' : 'Nhấn nút bỏ ẩn'}`);

    if (context?.chat) {
        const chat = context.chat;
        const unhiddenCount = chat.filter(msg => msg.is_system).length;

        Logger.debug(`【Bỏ ẩn toàn bộ】📊 Trạng thái hiện tại:`);
        Logger.debug(`【Bỏ ẩn toàn bộ】   - Tổng số tin nhắn: ${chat.length}`);
        Logger.debug(`【Bỏ ẩn toàn bộ】   - Số tin nhắn đã ẩn: ${unhiddenCount}`);

        chat.forEach(msg => {
            if (msg.is_system) {
                msg.is_system = false;
            }
        });

        const selector = $('.mes[is_system="true"]');
        const domCount = selector.length;
        selector.attr('is_system', 'false');

        Logger.debug(`【Bỏ ẩn toàn bộ】✅ Đã hủy trạng thái ẩn của tất cả tin nhắn`);
        Logger.debug(`【Bỏ ẩn toàn bộ】   - Cập nhật mảng chat: ${unhiddenCount} tin`);
        Logger.debug(`【Bỏ ẩn toàn bộ】   - Cập nhật phần tử DOM: ${domCount} phần tử`);
    }

    // Đặt cài đặt về null / trạng thái tắt
    Logger.debug(`【Bỏ ẩn toàn bộ】💾 Đặt lại cài đặt ẩn về null (Tắt tự động ẩn)`);
    saveCurrentHideSettings(null);

    if (isFromInputZero) {
        Logger.debug(`【Bỏ ẩn toàn bộ】✨ Giá trị ẩn đã đặt về 0, đã hủy bỏ ẩn toàn bộ các tầng hiện tại`);
        toastr.success('Giá trị ẩn đã đặt về 0, đã bỏ ẩn tất cả các tầng tin nhắn');
    } else {
        Logger.debug(`【Bỏ ẩn toàn bộ】✨ Đã hủy bỏ ẩn toàn bộ các tầng hiện tại`);
        toastr.success('Đã lập tức hủy bỏ ẩn tất cả các tầng tin nhắn hiện tại');
    }

    updateCurrentHideSettingsDisplay();

    const elapsed = (performance.now() - startTime).toFixed(2);
    Logger.debug(`【Bỏ ẩn toàn bộ】✅ Hoàn tất, tốn ${elapsed}ms`);
    Logger.debug('👁️👁️👁️【Bỏ ẩn toàn bộ】Kết thúc 👁️👁️👁️');
    Logger.debug('');
}

// ==================== Tính năng Thống kê chat (Token Stats) ====================

// Cập nhật giao diện thống kê Token
function updateTokenStatsUI() {
    Logger.debug("【Kích hoạt kết xuất UI】Vào updateTokenStatsUI, thử tính toán lại các loại Token");
    if (!promptManager) {
        Logger.warn("【Chẩn đoán thất bại】promptManager rỗng");
        return;
    }
    if (!promptManager.messages) {
        Logger.warn("【Chẩn đoán thất bại】promptManager.messages rỗng");
        return;
    }
    const pm = promptManager;

    // 1. Tính toán các giá trị Token
    const totalTokens = pm.tokenUsage || 0;
    let chatTokens = 0;
    Logger.debug(`【Dữ liệu chẩn đoán】Tổng Token trích xuất được hiện tại (pm.tokenUsage) = ${totalTokens}`);

    const findCollectionById = (c, id) => {
        if (c.identifier === id) return c;
        if (c.collection) {
            for (const i of c.collection) {
                if (i instanceof Object && i.collection) {
                    const f = findCollectionById(i, id);
                    if (f) return f;
                }
            }
        }
        return null;
    };

    // Đệ quy thu thập tất cả các đối tượng Message ở nút lá có identifier bắt đầu bằng prefix
    // Tương thích với cả 2 cấu trúc cây trước và sau khi squash:
    //   - Trước khi squash: chatHistory là MessageCollection (chứa .collection), cần đệ quy vào trong lấy Message con
    //   - Sau khi squash: chatHistory-N là các đối tượng Message nằm rải rác (không có .collection), trực tiếp thu thập là xong
    const collectLeafMessagesByPrefix = (c, prefix) => {
        const results = [];
        if (!c || !c.collection) return results;
        for (const i of c.collection) {
            if (!(i instanceof Object)) continue;
            if (i.identifier && i.identifier.startsWith(prefix)) {
                if (i.collection) {
                    // Nút MessageCollection — đệ quy lấy Message con
                    results.push(...collectLeafMessagesByPrefix(i, prefix));
                } else if (typeof i.getTokens === 'function') {
                    // Nút lá Message — thu thập trực tiếp
                    results.push(i);
                }
            } else if (i.collection) {
                // Không phải nút mục tiêu nhưng có nút con — tiếp tục đệ quy
                results.push(...collectLeafMessagesByPrefix(i, prefix));
            }
        }
        return results;
    };

    Logger.debug("【Quy trình chẩn đoán】Bắt đầu tìm nút có identifier bắt đầu bằng 'chatHistory' trong cấu trúc PromptManager");
    const chatMessages = collectLeafMessagesByPrefix(pm.messages, 'chatHistory');

    if (chatMessages.length > 0) {
        Logger.debug(`【Chẩn đoán thành công】Tìm thấy ${chatMessages.length} tin nhắn chatHistory`);
        chatMessages.forEach(msg => {
            if (msg.role === 'user' || msg.role === 'assistant') chatTokens += msg.getTokens();
        });
        Logger.debug(`【Dữ liệu chẩn đoán】Tính toán thành công tổng Token chat = ${chatTokens}`);
    } else {
        Logger.error("【Cảnh báo chẩn đoán quan trọng】Không tìm thấy nút 'chatHistory'! Cấu trúc bộ dựng Prompt của SillyTavern đã bị thay đổi.");
        try {
            let availableIdentifiers = [];
            if (pm.messages && pm.messages.collection) {
                availableIdentifiers = pm.messages.collection.map(c => c.identifier || 'Nút chưa đặt tên');
            }
            Logger.error(`【Trích xuất cấu trúc】Các identifiers cấp cao nhất hiện có: ${availableIdentifiers.join(', ')}`);
        } catch(e) {
            Logger.error("【Trích xuất cấu trúc】Xảy ra lỗi bất ngờ khi đọc cấu trúc: ", e);
        }
    }

    const wiTokens = calculatedWiTokens;
    let otherTokens = totalTokens - chatTokens - wiTokens;
    if (otherTokens < 0) otherTokens = 0;

    // 2. Dù panel có hiển thị hay không, đều cập nhật nội dung DOM ngầm bên dưới
    renderTokenStatsContent(totalTokens, chatTokens, wiTokens, otherTokens);
}

// Kết xuất nội dung thống kê Token
function renderTokenStatsContent(totalTokens, chatTokens, wiTokens, otherTokens, statsObj = wiDetailedStats) {
    if (!totalTokens && totalTokens !== 0) return;

    const getPct = (v) => totalTokens > 0 ? ((v / totalTokens) * 100).toFixed(1) : 0;

    // Kết xuất dòng tổng quan
    document.getElementById('tub-row-overview').innerHTML = `
        <div class="tub-stat-box"><span class="tub-stat-label">Tổng cộng</span><span class="tub-stat-value">${totalTokens}</span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">Đoạn chat</span><span class="tub-stat-value">${chatTokens}<br><small>${getPct(chatTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">World Info</span><span class="tub-stat-value">${wiTokens}<br><small>${getPct(wiTokens)}%</small></span></div>
        <div class="tub-stat-box"><span class="tub-stat-label">Khác</span><span class="tub-stat-value">${otherTokens}<br><small>${getPct(otherTokens)}%</small></span></div>
    `;

    // Tính toán token của World Info dạng hằng số, động và EJS
    let totalC = 0, totalD = 0, totalE = 0;
    for (const b in statsObj) {
        if (statsObj[b].constant) statsObj[b].constant.forEach(e => totalC += e.tokens);
        if (statsObj[b].dynamic) statsObj[b].dynamic.forEach(e => totalD += e.tokens);
        if (statsObj[b].ejs) statsObj[b].ejs.forEach(e => totalE += e.tokens);
    }
    renderPieView(totalC, totalD, totalE, totalC + totalD + totalE);

    // Kết xuất danh sách các mục
    const books = Object.keys(statsObj);
    let filtersHtml = '';
    if (books.length > 1) {
        filtersHtml = `
            <div class="tub-book-filters">
                <button class="tub-book-btn active" data-book="all">Tất cả mục</button>
                ${books.map(b => `<button class="tub-book-btn" data-book="${b}">${b}</button>`).join('')}
            </div>
        `;
    }

    const sectionHtml = `
        <div id="tub-entries-header-sticky" class="tub-entries-header-sticky">
            <div class="tub-flex-row-between">
                <div class="tub-flex-row-center">
                    <div class="tub-section-title tub-title-text tub-section-title-no-margin">Mục đã kích hoạt</div>
                    <div class="tub-search-wrapper">
                        <svg class="tub-search-icon" id="tub-search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                        </svg>
                        <input type="text" id="tub-search-input" class="tub-search-input" placeholder="Tìm kiếm mục...">
                    </div>
                </div>
                <div id="tub-entries-total-display" class="tub-entries-total-display"></div>
            </div>
            ${filtersHtml}
        </div>
        <div class="tub-row-3 tub-scrollable" id="tub-row-entries"></div>
    `;
    document.getElementById('tub-entries-section').innerHTML = sectionHtml;

    // Lưu trạng thái để phục vụ lọc kết hợp
    let currentBookFilter = 'all';
    let currentSearchTerm = '';

    const renderEntriesList = () => {
        const entriesContainer = document.getElementById('tub-row-entries');
        const totalDisplay = document.getElementById('tub-entries-total-display');
        entriesContainer.innerHTML = '';

        let combined = [];
        let filterTotalC = 0;
        let filterTotalD = 0;
        let filterTotalE = 0;

        for (const b in statsObj) {
            if (currentBookFilter !== 'all' && b !== currentBookFilter) continue;

            // Lọc và đẩy ejs
            if (statsObj[b].ejs) {
                statsObj[b].ejs.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'ejs' });
                    filterTotalE += e.tokens;
                });
            }
            // Lọc và đẩy dynamic
            if (statsObj[b].dynamic) {
                statsObj[b].dynamic.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'dynamic' });
                    filterTotalD += e.tokens;
                });
            }
            // Lọc và đẩy constant
            if (statsObj[b].constant) {
                statsObj[b].constant.forEach(e => {
                    if (currentSearchTerm && !e.name.toLowerCase().includes(currentSearchTerm)) return;
                    combined.push({ ...e, b, type: 'constant' });
                    filterTotalC += e.tokens;
                });
            }
        }

        const filterTotal = filterTotalC + filterTotalD + filterTotalE;
        // Xây dựng phần hiển thị tổng số trên đỉnh, nếu có EJS sẽ hiển thị phần màu đỏ
        let totalHtml = `${filterTotal} (`;
        if (filterTotalE > 0) totalHtml += `<span class="tub-stat-color-ejs">${filterTotalE}</span> + `;
        totalHtml += `<span class="tub-stat-color-dynamic">${filterTotalD}</span> + <span class="tub-stat-color-constant">${filterTotalC}</span>)`;
        totalDisplay.innerHTML = totalHtml;

        combined.sort((a, b) => {
            const order = { 'ejs': 1, 'dynamic': 2, 'constant': 3 };
            if (a.type !== b.type) return order[a.type] - order[b.type];
            return b.tokens - a.tokens;
        });

        if (!combined.length) {
            entriesContainer.innerHTML = '<div class="tub-empty-state">Không có mục nào được kích hoạt</div>';
            return;
        }

        const absoluteMax = Math.max(...combined.map(e => e.tokens));

        combined.forEach(e => {
            const pct = absoluteMax > 0 ? ((e.tokens / absoluteMax) * 100).toFixed(1) : 0;
            const bookTag = (currentBookFilter === 'all' && books.length > 1) ? ` <span class="tub-book-tag">(${e.b})</span>` : '';

            let gradientBg = '';
            if (e.type === 'ejs') {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-ejs) ${pct}%, transparent ${pct}%);`;
            } else if (e.type === 'constant') {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-constant) ${pct}%, transparent ${pct}%);`;
            } else {
                gradientBg = `background: linear-gradient(to right, var(--hh-stats-bg-dynamic) ${pct}%, transparent ${pct}%);`;
            }

            entriesContainer.insertAdjacentHTML('beforeend', `
                <div class="tub-new-list-item" style="${gradientBg}">
                    <div class="tub-nli-label" title="${e.name}">${e.name}${bookTag}</div>
                    <div class="tub-nli-value">${e.tokens}</div>
                </div>`);
        });

        // Đã gỡ bỏ logic thanh cuộn
    };

    renderEntriesList();

    // Gắn sự kiện nút sách
    if (books.length > 1) {
        const btns = document.querySelectorAll('.tub-book-btn');
        btns.forEach(btn => {
            btn.onclick = () => {
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentBookFilter = btn.getAttribute('data-book');
                renderEntriesList();
            };
        });
    }

    // Gắn sự kiện ô tìm kiếm
    const searchIcon = document.getElementById('tub-search-icon');
    const searchInput = document.getElementById('tub-search-input');

    searchIcon.onclick = () => {
        searchInput.classList.toggle('active');
        if (searchInput.classList.contains('active')) {
            searchInput.focus();
        } else {
            searchInput.value = '';
            currentSearchTerm = '';
            renderEntriesList();
        }
    };

    searchInput.addEventListener('input', debounce((e) => {
        currentSearchTerm = e.target.value.toLowerCase();
        renderEntriesList();
    }, 300));
}

// Kết xuất biểu đồ tròn (Thêm phần lát cắt đỏ EJS)
function renderPieView(c, d, e, total) {
    const container = document.getElementById('tub-row-wi-chart');
    if (!total) { container.innerHTML = '<div class="tub-empty-state">Không có World Info nào được kích hoạt</div>'; return; }

    const cPct = (c / total) * 100;
    const dPct = (d / total) * 100;
    const ePct = (e / total) * 100;

    const cAngle = (cPct / 2) * 3.6;
    const cRad = (cAngle - 90) * (Math.PI / 180);
    const cX = 50 + 30 * Math.cos(cRad);
    const cY = 50 + 30 * Math.sin(cRad);

    const dAngle = (cPct + dPct / 2) * 3.6;
    const dRad = (dAngle - 90) * (Math.PI / 180);
    const dX = 50 + 30 * Math.cos(dRad);
    const dY = 50 + 30 * Math.sin(dRad);

    // Tính toán tọa độ chữ lát cắt EJS
    const eAngle = (cPct + dPct + ePct / 2) * 3.6;
    const eRad = (eAngle - 90) * (Math.PI / 180);
    const eX = 50 + 30 * Math.cos(eRad);
    const eY = 50 + 30 * Math.sin(eRad);

    container.innerHTML = `
        <div class="tub-pie-chart" style="background: conic-gradient(#3b82f6 0% ${cPct}%, #22c55e ${cPct}% ${cPct + dPct}%, #ef4444 ${cPct + dPct}% 100%);">
            ${cPct >= 5 ? `<span class="tub-pie-text" style="left: ${cX}px; top: ${cY}px;">${cPct.toFixed(0)}%</span>` : ''}
            ${dPct >= 5 ? `<span class="tub-pie-text" style="left: ${dX}px; top: ${dY}px;">${dPct.toFixed(0)}%</span>` : ''}
            ${ePct >= 5 ? `<span class="tub-pie-text" style="left: ${eX}px; top: ${eY}px;">${ePct.toFixed(0)}%</span>` : ''}
        </div>
        <div class="tub-legend">
            ${e > 0 ? `<div class="tub-legend-item"><span class="tub-dot tub-dot-red"></span>EJS: ${e}</div>` : ''}
            <div class="tub-legend-item"><span class="tub-dot tub-dot-green"></span>Đèn xanh (Động): ${d}</div>
            <div class="tub-legend-item"><span class="tub-dot tub-dot-blue"></span>Đèn xanh dương (Hằng): ${c}</div>
        </div>
    `;
}

// Logic tự động ẩn/hiện thanh cuộn (Đã gỡ bỏ)
function initScrollbarLogic() {
}

// ==================== Kết thúc tính năng Thống kê chat ====================

// --- Modal nhật ký cập nhật (Changelog) ---
function createChangelogModalHtml(changelogText) {
    return `
    <div class="hide-modal-box" id="hide-helper-modal-update">
        <div class="hide-modal-header">Nhật ký cập nhật tiện ích</div>
        <div class="hide-changelog-viewer" id="hide-helper-changelog-content">${changelogText}</div>
        <div class="hide-update-tip">Nếu cập nhật thất bại, bạn có thể cập nhật thủ công Trợ lý ẩn tầng trong danh sách 【Quản lý tiện ích mở rộng】 trên trang Extensions của SillyTavern. Nếu vẫn thất bại, hãy thử xóa đi cài đặt lại để dùng bản mới nhất.</div>
        <div class="hide-modal-footer">
            <button id="hide-helper-btn-confirm-update" class="menu_button primary">Cập nhật ngay</button>
            <button class="menu_button" onclick="document.getElementById('hide-helper-modal-overlay').classList.remove('visible')">Hủy</button>
        </div>
    </div>`;
}

async function showUpdateModal() {
    const overlay = document.getElementById('hide-helper-modal-overlay');
    if (!overlay) return;

    // Hiển thị Loading trước
    overlay.innerHTML = `<div class="hide-modal-box" style="text-align:center; padding:30px;">Đang tải nhật ký cập nhật...</div>`;
    overlay.classList.add('visible');

    const changelog = await getChangelog();

    // Xử lý escape ký tự Markdown cơ bản
    const safeLog = changelog.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    overlay.innerHTML = createChangelogModalHtml(safeLog);

    const btnUpdate = document.getElementById('hide-helper-btn-confirm-update');
    if (btnUpdate) {
        btnUpdate.onclick = async () => {
            if (confirm('Thao tác cập nhật sẽ làm mới trang, vui lòng đảm bảo đã lưu lại đoạn chat.\nXác nhận cập nhật?')) {
                btnUpdate.disabled = true;
                btnUpdate.textContent = "Đang cập nhật...";
                try {
                    const res = await performUpdate();
                    if (res.ok) {
                        alert('Lệnh cập nhật đã gửi, trang chuẩn bị tải lại.');
                        setTimeout(() => location.reload(), 2000);
                    } else {
                        alert('Cập nhật thất bại, vui lòng kiểm tra console log.');
                        btnUpdate.disabled = false;
                    }
                } catch (e) {
                    alert('Yêu cầu cập nhật xảy ra lỗi: ' + e);
                    btnUpdate.disabled = false;
                }
            }
        };
    }
}

/**
 * Cập nhật thông tin hiển thị phiên bản
 */
function updateVersionDisplay(updateInfo) {
    if (!updateInfo) return;

    const currentVersionEl = $('#hide-helper-current-version');
    const newBadgeEl = $('#hide-helper-new-badge');
    const checkBtn = $('#hide-helper-check-update-btn');

    if (currentVersionEl.length) {
        currentVersionEl.text(updateInfo.localVersion || 'Không xác định');
    }

    if (newBadgeEl.length) {
        if (updateInfo.hasUpdate) {
            newBadgeEl.show();
            if (checkBtn.length) {
                checkBtn.addClass('has-update');
                checkBtn.text('Có bản mới');
                checkBtn.attr('title', `Phiên bản mới nhất: ${updateInfo.latestVersion}`);
            }
        } else {
            newBadgeEl.hide();
            if (checkBtn.length) {
                checkBtn.removeClass('has-update');
                checkBtn.text('Kiểm tra cập nhật');
                checkBtn.removeAttr('title');
            }
        }
    }
}

// Bộ hẹn giờ tự động đóng UI nhật ký (Cơ chế tự ngắt sau 60 phút)
let logUiAutoDisableTimer = null;

// Logic đóng thống nhất cho UI nhật ký (Trạng thái DOM + Cài đặt + Hẹn giờ + Lịch sử Log)
function disableLogUi(silent = false) {
    clearTimeout(logUiAutoDisableTimer);
    const $toggle = $('#hide-helper-log-ui-toggle');
    if ($toggle.is(':checked')) {
        $toggle.prop('checked', false);
    }
    $('.log-level-selector-wrapper').slideUp(200);
    $('#hide-helper-download-log').fadeOut(200);
    extension_settings[extensionName].logUiVisible = false;
    extension_settings[extensionName].logUiOpenedAt = null;
    extension_settings[extensionName].logLevel = 0;
    applyLogLevel(0);
    saveSettingsDebounced();
    Logger.logHistory = [];
    if (!silent) {
        // toastr.info('Để bảo đảm hiệu năng, tính năng hiển thị log đã đạt giới hạn 60 phút và tự động tắt, đưa mức log về 0.');
    }
}

// Hàm tiện ích thu thập thông tin môi trường (XPath)
function logEnvironmentDetails() {
    if (Logger.currentLevel !== 3) return; // Chỉ thu thập ở mức độ 3
    const getXPathText = (xpath) => {
        try {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return result.singleNodeValue ? result.singleNodeValue.textContent.trim() : "Không tìm thấy";
        } catch (e) { return "Lỗi khi lấy"; }
    };
    const stVersion = getXPathText('//*[@id="version_display"]');
    const thVersion = getXPathText('//*[@id="tavern_helper"]/div/div[2]/div/div[1]/span');

    Logger.debug(`【Chẩn đoán gỡ lỗi】Phiên bản SillyTavern: ${stVersion}`);
    Logger.debug(`【Chẩn đoán gỡ lỗi】Phiên bản Tavern Helper: ${thVersion}`);
    Logger.debug(`【Chẩn đoán gỡ lỗi】Cài đặt nội bộ Hide Helper:`, extension_settings[extensionName]);
}

// Thiết lập bộ lắng nghe sự kiện cho các phần tử UI
function setupEventListeners() {
    Logger.debug('Thiết lập bộ lắng nghe sự kiện');

    // --- Lắng nghe sự kiện Thống kê chat (Token Stats) ---

    // Gắn bộ đánh chặn ST-PT
    setupSTPTInterceptor();

    // Sự kiện hoàn tất quét World Info
    eventSource.on(event_types.WORLDINFO_SCAN_DONE, async (data) => {
        Logger.debug("【Sự kiện chẩn đoán】Nhận được tín hiệu WORLDINFO_SCAN_DONE của World Info");

        // Chỉ chấp nhận kết quả quét được kích hoạt chủ động từ dry run của plugin, bỏ qua quét ngầm
        if (!isOurWiScan) {
            Logger.debug("【Lọc quét WI】Lần quét này không phải do plugin kích hoạt, bỏ qua cập nhật dữ liệu");
            return;
        }

        if (!data) {
            Logger.warn("【Cảnh báo chẩn đoán】Dữ liệu data của sự kiện quét World Info bị rỗng");
            return;
        }
        if (!data.activated || !data.activated.entries) {
            Logger.warn("【Cảnh báo chẩn đoán】Không tìm thấy cấu trúc activated.entries từ data", data);
            return;
        }

        calculatedWiTokens = 0;
        wiDetailedStats = {};
        const entries = Array.from(data.activated.entries.values());
        Logger.debug(`【Dữ liệu chẩn đoán】Trích xuất thành công số lượng mục World Info được kích hoạt: ${entries.length}`);

        await Promise.all(entries.map(async (entry) => {
            const tokens = await getTokenCountAsync(entry.content);
            const bookName = entry.world || "Embedded/Other";
            let entryName = entry.comment || (entry.key && entry.key[0] ? `[Key: ${entry.key[0]}]` : `[UID: ${entry.uid}]`);
            const type = entry.constant ? "constant" : "dynamic";

            if (!wiDetailedStats[bookName]) {
                wiDetailedStats[bookName] = { constant: [], dynamic: [], ejs: [], total: 0 };
            }
            wiDetailedStats[bookName][type].push({ name: entryName, tokens: tokens });
            wiDetailedStats[bookName].total += tokens;
            calculatedWiTokens += tokens;
        }));

        // Làm mới UI để hiển thị dữ liệu World Info mới nhất
        updateTokenStatsUI();
    });

    // Sự kiện cập nhật World Info
    if (event_types.WORLDINFO_UPDATED) {
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            updateTokenStatsUI();
        });
    }

    // Khai báo một khóa trạng thái hợp nhất bên ngoài để tránh một lượt bị hợp nhất trùng lặp
    let stptMergedThisTurn = false;

    // Đặt lại khóa mỗi khi bắt đầu một lượt tạo mới
    eventSource.on(event_types.GENERATION_STARTED, () => {
        stptMergedThisTurn = false;
    });

    // Lắng nghe sự kiện sẵn sàng tạo để ghép nối dữ liệu
    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (completion) => {
        // 🌟【Cơ chế cốt lõi】：Nếu đây là lượt gửi giả lập do chúng ta tự kích hoạt, dừng ngay lập tức, không gửi cho AI!
        if (isFakeGenerating) {
            stopGeneration();
            isFakeGenerating = false;
            // Sau khi chặn dry run, giữ isOurWiScan thêm một khoảng ngắn
            // để đảm bảo các sự kiện quét WI sau đó trong cùng một đợt vẫn được chấp nhận
            setTimeout(() => { isOurWiScan = false; }, 500);
            Logger.debug('Tạo giả lập đã được đánh chặn, lấy dữ liệu mới nhất thành công');
        }

        if (!completion || !completion.messages) return;

        setTimeout(async () => {
            try {
                if (stptMergedThisTurn) return; // Chống thực thi trùng lặp
                stptMergedThisTurn = true;

                // Loại bỏ trùng lặp
                const processedSTPT = new Map();
                for (const entry of stptInterceptedEntries) {
                    const key = `${entry.world}::${entry.comment}`;
                    if (!processedSTPT.has(key)) processedSTPT.set(key, entry);
                }

                if (processedSTPT.size > 0) {
                    console.log(`[Trợ lý ẩn tầng] Chuẩn bị ghép nối các mục tải động ST-PT:`, Array.from(processedSTPT.keys()));
                }

                let addedTokens = 0;

                // 🌟【Sửa lỗi cốt lõi】：Hợp nhất trực tiếp vĩnh viễn dữ liệu ST-PT vào biến toàn cục gốc của SillyTavern
                for (const stat of processedSTPT.values()) {
                    const textToMeasure = stat.rawText || '';
                    if (textToMeasure.trim() === '') continue;

                    const tk = await getTokenCountAsync(textToMeasure);
                    addedTokens += tk;

                    let finalBookName = stat.world || 'World Info chưa chỉ định';
                    let finalEntryName = stat.comment || 'Mục không rõ';

                    // Ghi vào đối tượng toàn cục gốc wiDetailedStats
                    if (!wiDetailedStats[finalBookName]) {
                        wiDetailedStats[finalBookName] = { constant: [], dynamic: [], ejs: [], total: 0 };
                    }
                    if (!wiDetailedStats[finalBookName].ejs) {
                        wiDetailedStats[finalBookName].ejs = [];
                    }
                    wiDetailedStats[finalBookName].ejs.push({
                        name: finalEntryName,
                        tokens: tk
                    });
                    wiDetailedStats[finalBookName].total += tk;
                }

                // 🌟 Cộng dồn vào biến Token toàn cục gốc
                calculatedWiTokens += addedTokens;

                // 🌟 Cưỡng chế làm mới UI! Vì biến toàn cục đã được sửa đổi, việc render panel sẽ tương thích hoàn hảo với dữ liệu ST-PT
                updateTokenStatsUI();

            } catch (err) {
                console.error("[Trợ lý ẩn tầng] Xuất hiện ngoại lệ khi ghép nối dữ liệu ST-PT:", err);
            }
        }, 800);
    });

    // --- Kết thúc lắng nghe sự kiện Thống kê chat ---

    // --- Tương tác giữa Popup và Tabs ---

    // Ghi nhận xem trong phiên mở popup hiện tại đã làm mới thống kê chưa
    let hasStatsRefreshedThisSession = false;

    $('#hide-helper-wand-button').on('click', function() {
        Logger.debug('Nút đũa thần được nhấp');
        if (!extension_settings[extensionName]?.enabled) {
            Logger.debug('Tiện ích đã bị tắt');
            toastr.warning('Trợ lý ẩn tầng hiện đang bị tắt, vui lòng vào trang Tiện ích mở rộng ở thanh menu trên cùng để bật.');
            return;
        }
        Logger.debug('Tiện ích đang bật, hiển thị popup sau khi cập nhật giao diện');
        updateCurrentHideSettingsDisplay();

        // Hiển thị chú thích cảnh báo màu đỏ trong ngoặc ở lần mở đầu tiên
        const titleEl = $('#hide-panel-instructions-title');
        if (!extension_settings[extensionName].hide_instructions_viewed) {
            titleEl.html('Hướng dẫn sử dụng<span class="title-warning-text">（Cuộn xuống dưới để xem toàn bộ nội dung）</span>');
            extension_settings[extensionName].hide_instructions_viewed = true;
            saveSettingsDebounced();
        } else {
            titleEl.text('Hướng dẫn sử dụng');
        }

        // Khôi phục lại tab được kích hoạt ở lần trước
        const lastActiveTab = extension_settings[extensionName].last_active_tab || 'hide-panel';
        $('.tab-button').removeClass('active');
        $(`.tab-button[data-tab="${lastActiveTab}"]`).addClass('active');
        $('.tab-panel').removeClass('active');
        $(`.tab-panel[data-tab="${lastActiveTab}"]`).addClass('active');

        // Đặt lại trạng thái làm mới thống kê của phiên popup
        hasStatsRefreshedThisSession = false;

        // ---- 【Mở popup lập tức chạy thống kê】 ----
        updateTokenStatsUI();
        if (lastActiveTab === 'token-stats-panel') {
            forceRefreshTokenStats(); // Nếu người dùng mở ra trúng ngay tab thống kê, kích hoạt làm mới ngay
            hasStatsRefreshedThisSession = true; // Đánh dấu phiên này đã được làm mới
        }

        const $popup = $('#hide-helper-popup');
        const $backdrop = $('#hide-helper-backdrop');
        $backdrop.show();
        $popup.show();
        centerPopup($popup);
        $(window).off('resize.hideHelperMain').on('resize.hideHelperMain', () => centerPopup($popup));

        // Khôi phục trạng thái công tắc UI log
        const logUiVisible = extension_settings[extensionName].logUiVisible || false;
        const logUiOpenedAt = extension_settings[extensionName].logUiOpenedAt || null;
        const LOG_UI_TIMEOUT = 60 * 60 * 1000; // 60 phút

        // Kiểm tra xem đã vượt quá thời hạn tự ngắt 60 phút hay chưa (kiểm tra liên phiên)
        if (logUiVisible && logUiOpenedAt && (Date.now() - logUiOpenedAt >= LOG_UI_TIMEOUT)) {
            disableLogUi();
        } else if (logUiVisible) {
            $('#hide-helper-log-ui-toggle').prop('checked', true);
            $('.log-level-selector-wrapper').slideDown(0);
            if (extension_settings[extensionName].logLevel === 3) {
                $('#hide-helper-download-log').show();
            } else {
                $('#hide-helper-download-log').hide();
            }

            // Khởi động/gia hạn bộ tự ngắt 60 phút (tính thời gian còn lại)
            clearTimeout(logUiAutoDisableTimer);
            const elapsed = logUiOpenedAt ? Date.now() - logUiOpenedAt : 0;
            const remaining = Math.max(0, LOG_UI_TIMEOUT - elapsed);
            logUiAutoDisableTimer = setTimeout(() => {
                disableLogUi();
            }, remaining);
        } else {
            $('#hide-helper-log-ui-toggle').prop('checked', false);
            $('.log-level-selector-wrapper').slideUp(0);
            $('#hide-helper-download-log').hide();
        }

        // Hiển thị popup gợi ý giao diện (nếu là lần đầu mở)
        if (!extension_settings[extensionName].theme_notification_viewed) {
            showThemeNotification();
        }
    });

    // Hàm xử lý đóng popup thống nhất
    function closePopup() {
        Logger.debug('');
        Logger.debug('🚪🚪🚪【Đóng popup】Bắt đầu 🚪🚪🚪');

        // Đảm bảo cài đặt trong ô nhập liệu đã được lưu
        const $input = $('#hide-last-n');
        const inputVal = $input.val();
        const val = parseInt(inputVal);

        Logger.debug(`【Đóng popup】📋 Trạng thái ô nhập liệu:`);
        Logger.debug(`【Đóng popup】   - Giá trị gốc: "${inputVal}"`);
        Logger.debug(`【Đóng popup】   - Sau khi parse: ${val}`);
        Logger.debug(`【Đóng popup】   - Có hợp lệ không: ${!isNaN(val) && val >= 0}`);

        if (!isNaN(val) && val >= 0) {
            Logger.debug(`【Đóng popup】💾 Lưu ngay cài đặt ẩn, giá trị=${val}`);

            if (val > 0) {
                saveCurrentHideSettings(val);
            } else {
                saveCurrentHideSettings(null);
            }

            updateCurrentHideSettingsDisplay();

            // Thực thi kiểm tra ẩn ngay lập tức, không dùng debounce
            const settings = extension_settings[extensionName];
            if (settings?.enabled && settings?.autoHideEnabled) {
                Logger.debug(`【Đóng popup】🔍 Tiện ích và tính năng tự động ẩn đang bật, thực thi kiểm tra ẩn toàn lượng ngay`);
                runFullHideCheck();
            } else {
                Logger.debug(`【Đóng popup】⛔ Tiện ích hoặc tự động ẩn chưa bật, bỏ qua kiểm tra ẩn`);
                Logger.debug(`【Đóng popup】   - enabled: ${settings?.enabled}`);
                Logger.debug(`【Đóng popup】   - autoHideEnabled: ${settings?.autoHideEnabled}`);
            }
        } else {
            Logger.debug(`【Đóng popup】⚠️  Giá trị nhập không hợp lệ (${inputVal}), bỏ qua lưu`);
        }

        $('#hide-helper-popup').hide();
        $('#hide-helper-backdrop').hide();
        $(window).off('resize.hideHelperMain');

        Logger.debug(`【Đóng popup】✅ Popup đã đóng`);
        Logger.debug('🚪🚪🚪【Đóng popup】Kết thúc 🚪🚪🚪');
        Logger.debug('');
    }

    $('#hide-helper-popup-close-icon').on('click', function() {
        Logger.debug('【Sự kiện】Nhấp biểu tượng đóng popup');
        closePopup();
    });

    // Nhấp vào backdrop để đóng popup
    $('#hide-helper-backdrop').on('click', function() {
        Logger.debug('【Sự kiện】Nhấp vào lớp nền backdrop');
        closePopup();
    });

    // Thêm mới: Phím ESC đóng nhanh popup
    $(document).off('keydown.hideHelperEsc').on('keydown.hideHelperEsc', function(e) {
        if (e.key === 'Escape' && $('#hide-helper-popup').is(':visible')) {
            Logger.debug('【Sự kiện】Nhấn phím ESC');
            closePopup();
        }
    });

    // --- Sự kiện chuyển đổi giao diện Sáng / Tối ---
    $(document).on('click', '#hide-helper-theme-toggle', function() {
        const currentTheme = extension_settings[extensionName].theme || 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        extension_settings[extensionName].theme = newTheme;
        applyTheme(newTheme);
        saveSettingsDebounced();

        // Render lại thống kê chat theo thời gian thực để cập nhật dải màu gradient trên từng dòng
        if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
            updateTokenStatsUI();
        }
    });

    // --- Sự kiện chuyển đổi mức độ nhật ký (Log Level) ---
    $(document).on('change', '#hide-helper-log-level-select', function() {
        const newLevel = parseInt($(this).val());
        extension_settings[extensionName].logLevel = newLevel;
        applyLogLevel(newLevel);
        saveSettingsDebounced();

        const $downloadBtn = $('#hide-helper-download-log');
        if (newLevel === 3) {
            $downloadBtn.fadeIn(200);
            logEnvironmentDetails(); // Chuyển sang mức 3 lập tức thu thập thông tin môi trường
        } else {
            $downloadBtn.fadeOut(200);
            Logger.logHistory = []; // Không phải mức 3, lập tức dọn sạch bộ nhớ log rác
        }

        if (newLevel > 0) {
            console.log(`%c[Trợ lý ẩn tầng]`, 'font-weight: bold; color: #28a745;', `Mức độ nhật ký đã đổi thành: ${['Tắt log', 'Log cốt lõi', 'Log hoạt động', 'Log đầy đủ'][newLevel]}`);
        }
    });

    // --- Sự kiện popup gợi ý giao diện ---

    // Nút chuyển ngay sang giao diện Tối
    $(document).on('click', '#hide-helper-switch-theme-now', function() {
        const newTheme = 'dark';
        extension_settings[extensionName].theme = newTheme;
        applyTheme(newTheme);
        extension_settings[extensionName].theme_notification_viewed = true;
        saveSettingsDebounced();
        closeThemeNotification();

        // Render lại thống kê chat theo thời gian thực
        if ($('.tab-panel[data-tab="token-stats-panel"]').hasClass('active')) {
            updateTokenStatsUI();
        }
    });

    // Nút Đã hiểu
    $(document).on('click', '#hide-helper-notification-close', function() {
        extension_settings[extensionName].theme_notification_viewed = true;
        saveSettingsDebounced();
        closeThemeNotification();
    });

    // --- Sự kiện công tắc hiển thị UI nhật ký (Kèm đếm ngược 60 phút) ---
    $(document).on('change', '#hide-helper-log-ui-toggle', function() {
        const isVisible = $(this).is(':checked');
        extension_settings[extensionName].logUiVisible = isVisible;

        const $logLevelWrapper = $('.log-level-selector-wrapper');
        const $downloadBtn = $('#hide-helper-download-log');

        if (isVisible) {
            $logLevelWrapper.slideDown(200);
            if (extension_settings[extensionName].logLevel === 3) {
                $downloadBtn.fadeIn(200);
                logEnvironmentDetails();
            }

            // Ghi lại mốc thời gian mở, dùng cho kiểm tra tự ngắt 60 phút xuyên suốt các phiên
            extension_settings[extensionName].logUiOpenedAt = Date.now();
            saveSettingsDebounced();

            // Khởi động bộ tự ngắt 60 phút
            clearTimeout(logUiAutoDisableTimer);
            logUiAutoDisableTimer = setTimeout(() => {
                disableLogUi();
            }, 60 * 60 * 1000); // 60 phút

        } else {
            // Khi đóng UI, dọn dẹp toàn bộ cài đặt liên quan để tránh ngốn hiệu năng nền
            $logLevelWrapper.slideUp(200);
            $downloadBtn.fadeOut(200);
            clearTimeout(logUiAutoDisableTimer);

            // Cưỡng chế đưa mức log về 0 và dọn sạch bộ nhớ
            extension_settings[extensionName].logLevel = 0;
            extension_settings[extensionName].logUiOpenedAt = null;
            applyLogLevel(0);
            saveSettingsDebounced();
            Logger.logHistory = [];
        }
    });

    // --- Sự kiện nút tải xuống nhật ký ---
    $(document).on('click', '#hide-helper-download-log', function() {
        logEnvironmentDetails(); // Ghi thêm một lần thông tin môi trường trước khi tải
        if (Logger.exportLogs()) {
            toastr.success('Xuất file nhật ký thành công!');
        } else {
            toastr.warning('Hiện không có nội dung nhật ký nào để xuất.');
        }
    });

    // --- Sự kiện nút kiểm tra cập nhật ---
    $(document).on('click', '#hide-helper-check-update-btn', async function(e) {
        e.stopPropagation();
        const btn = $(this);

        // Nếu đã ở trạng thái màu đỏ (có bản cập nhật mới), nhấp vào sẽ mở modal changelog và xác nhận
        if (btn.hasClass('has-update')) {
            showUpdateModal();
        } else {
            const originalText = btn.text();

            // Vô hiệu hóa nút tránh nhấp nhiều lần
            btn.prop('disabled', true);
            btn.text('Đang kiểm tra...');

            try {
                // Ép kiểm tra cập nhật
                const updateInfo = await checkForUpdates(true);
                updateVersionDisplay(updateInfo);

                if (updateInfo.hasUpdate) {
                    toastr.success(`Phát hiện phiên bản mới: ${updateInfo.latestVersion}`);
                } else {
                    // Thêm kiểm tra dự phòng, khi mất kết nối mạng sẽ không báo nhầm là bản mới nhất
                    if (updateInfo.latestVersion === "Check Failed") {
                        toastr.error('Kiểm tra thất bại, không thể kết nối tới kho lưu trữ GitHub');
                        btn.text('Kiểm tra thất bại');
                    } else {
                        toastr.info('Hiện tại đã là phiên bản mới nhất');
                        btn.text('Đã là mới nhất');
                    }
                    setTimeout(() => {
                        btn.text('Kiểm tra cập nhật');
                    }, 2000);
                }
            } catch (err) {
                Logger.error('Kiểm tra cập nhật thất bại:', err);
                toastr.error('Kiểm tra cập nhật thất bại, vui lòng thử lại sau');
                btn.text(originalText);
            } finally {
                btn.prop('disabled', false);
            }
        }
    });

    // Thêm mới: Logic chuyển đổi Tab
    $(document).on('click', '.tab-button', function() {
        const targetTab = $(this).data('tab');
        $('.tab-button').removeClass('active');
        $(this).addClass('active');
        $('.tab-panel').removeClass('active');
        $(`.tab-panel[data-tab="${targetTab}"]`).addClass('active');

        // Lưu tab vừa chọn
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].last_active_tab = targetTab;
            saveSettingsDebounced();
        }

        // Nếu chuyển sang tab Thống kê chat, cập nhật UI
        if (targetTab === 'token-stats-panel') {
            updateTokenStatsUI(); // Kết xuất với dữ liệu hiện tại trước để tránh bị trống
            forceRefreshTokenStats(); // Mỗi lần chuyển tab đều kích hoạt tạo giả lập để đảm bảo số liệu mới nhất
        }

        // Chuyển nội dung panel rất dễ làm thay đổi chiều cao, tính toán lại để đảm bảo luôn căn giữa hoàn hảo
        centerPopup($('#hide-helper-popup'));
    });

    // --- Công tắc tiện ích toàn cục ---
    $('#hide-helper-toggle').on('change', function() {
        const isEnabled = $(this).val() === 'enabled';
        Logger.info(`Thay đổi trạng thái công tắc toàn cục: ${isEnabled ? 'Bật' : 'Tắt'}`);
        if (extension_settings[extensionName]) {
            extension_settings[extensionName].enabled = isEnabled;
            Logger.debug('Lưu cài đặt toàn cục');
            saveSettingsDebounced();
        }

        if (isEnabled) {
            Logger.debug('Tiện ích đã bật, chạy kiểm tra toàn lượng');
            toastr.success('Trợ lý ẩn tầng đã được bật');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('Tiện ích đã tắt');
            toastr.warning('Trợ lý ẩn tầng đã tắt');
        }
    });

    // --- Panel 1: Cài đặt Hide ---

    // 1. Thêm mới: Chuyển đổi công tắc tổng tính năng
    $('#hide-auto-process-toggle').on('change', function() {
        const isEnabled = $(this).is(':checked');
        Logger.debug('');
        Logger.debug(`🔧【Cài đặt】Công tắc tính năng tự động ẩn: ${isEnabled ? 'BẬT' : 'TẮT'}`);

        extension_settings[extensionName].autoHideEnabled = isEnabled;
        saveSettingsDebounced();
        updateCurrentHideSettingsDisplay();

        if (isEnabled) {
            Logger.debug('🔧【Cài đặt】Tự động ẩn đã bật, thực thi kiểm tra toàn lượng');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🔧【Cài đặt】Tự động ẩn đã tắt');
        }
        Logger.debug('');
    });

    $('#hide-mode-toggle').on('change', function() {
        const newMode = $(this).is(':checked');
        Logger.debug('');
        Logger.debug(`🔧【Cài đặt】Chuyển đổi chế độ: ${newMode ? 'Chế độ toàn cục' : 'Chế độ nhân vật'}`);

        if (extension_settings[extensionName]) {
            if (!extension_settings[extensionName].globalHideSettings) {
                extension_settings[extensionName].globalHideSettings = { ...defaultSettings.globalHideSettings };
            }

            extension_settings[extensionName].useGlobalSettings = newMode;
            Logger.debug(`🔧【Cài đặt】useGlobalSettings đã cập nhật thành: ${newMode}`);
            saveSettingsDebounced();
            updateCurrentHideSettingsDisplay();
            Logger.debug('🔧【Cài đặt】Thực thi kiểm tra toàn lượng để áp dụng chế độ mới');
            runFullHideCheckDebounced();
            toastr.info(`Đã chuyển phạm vi ẩn sang ${newMode ? 'Chế độ toàn cục' : 'Chế độ nhân vật'}`);
        }
        Logger.debug('');
    });

    // 2. Chỉnh sửa: Chỉ lưu khi ô nhập mất tiêu điểm (blur) để tránh kích hoạt lưu liên tục trong lúc gõ
    $('#hide-last-n').on('blur', function() {
        saveSettingsAutoDebounced();
    });

    // Phím Enter làm ô nhập mất tiêu điểm, từ đó kích hoạt lưu
    $('#hide-last-n').on('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.blur(); // Mất tiêu điểm sẽ kích hoạt sự kiện blur để lưu
        }
    });

    // 3. Chỉnh sửa: Nút bỏ ẩn
    $('#hide-unhide-all-btn').on('click', function() {
        unhideAllMessages(false);
    });

    // --- Panel 2: Cài đặt Limiter ---

    // Thêm từ khóa async và nhận đối tượng sự kiện e để nhận biết nguồn kích hoạt
    async function onLimiterSettingsChange(e) {
        if (_limiterSyncing) return;
        _limiterSyncing = true;

        try {
            const settings = extension_settings[extensionName];
            const isEnabled = $('#limiter-enabled').is(':checked');

            // 1. Nếu người dùng nhấp vào "Công tắc tính năng"
            if (e.target.id === 'limiter-enabled') {
                settings.limiter_isEnabled = isEnabled;

                if (isEnabled) {
                    // Khi bật lại, ưu tiên lấy giá trị hiện tại gốc của SillyTavern
                    // (Vì trong thời gian tiện ích bị tắt, người dùng có thể đã sửa trên giao diện gốc)
                    let currentNative = Number($('#chat_truncation').val());
                    if (isNaN(currentNative) || currentNative <= 0) {
                        currentNative = power_user.chat_truncation || 0;
                    }
                    if (currentNative > 0) {
                        settings.limiter_saved_count = currentNative;
                    }
                }

                // Cập nhật hiển thị UI ngay lập tức
                updateCurrentHideSettingsDisplay();
            }

            // Lấy con số đã được xác định mới nhất
            const count = parseInt($('#limiter-count').val(), 10) || 0;

            if (isEnabled && count > 0) {
                // 【Đồng bộ cốt lõi】：Lưu vĩnh viễn giá trị người dùng thiết lập vào biến bóng của plugin
                settings.limiter_saved_count = count;

                // Đồng bộ sang chat_truncation gốc
                power_user.chat_truncation = count;
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(count);
                    $('#chat_truncation_counter').val(count);
                    $('#chat_truncation').trigger('change'); // Kích hoạt lưu gốc
                }
            }

            // Ép lưu ghi đĩa vào settings.json
            await saveSettings();

            // Nếu sửa thủ công giá trị trong ô nhập, tải lại đoạn chat hiện tại
            if (isEnabled && count > 0 && e.target.id === 'limiter-count') {
                const { reloadCurrentChat } = getContext();
                if (reloadCurrentChat) {
                    reloadCurrentChat();
                }
            }
        } finally {
            _limiterSyncing = false;
        }
    }
    $('#limiter-enabled, #limiter-count').on('change', onLimiterSettingsChange);

    // --- 【Đồng bộ ngược khi sửa trên giao diện gốc】: #chat_truncation gốc thay đổi → biến bóng của plugin ---
    $('#chat_truncation').on('input', function() {
        if (_limiterSyncing) return;
        _limiterSyncing = true;

        try {
            const nativeValue = Number($(this).val()) || 0;
            const settings = extension_settings[extensionName];

            // 【Bảo vệ ngầm】：Bất kể tiện ích có bật hay không, chỉ cần người dùng sửa thủ công trên giao diện gốc thì cập nhật ngay sao lưu biến bóng
            if (nativeValue > 0) {
                settings.limiter_saved_count = nativeValue;
                // Chỉ lưu dữ liệu tiện ích, không cần làm mới toàn bộ UI
                saveSettingsDebounced();
            }

            // Nếu tiện ích đang bật và popup đang mở, đổi luôn số trong ô nhập liệu popup để đồng bộ thị giác
            if (settings.limiter_isEnabled && $('#hide-helper-popup').is(':visible')) {
                $('#limiter-count').val(nativeValue > 0 ? nativeValue : '');
            }
        } finally {
            _limiterSyncing = false;
        }
    });

    // --- Lắng nghe các sự kiện cốt lõi (Phối hợp làm việc) ---

    eventSource.on(event_types.CHAT_CHANGED, (data) => {
        Logger.debug('');
        Logger.debug('📢【Sự kiện】CHAT_CHANGED - Đã chuyển đổi đoạn chat');
        cachedContext = null; // Xóa cache

        updateCurrentHideSettingsDisplay(); // Cập nhật lại toàn bộ UI

        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('📢【Sự kiện】Tiện ích đang bật, thực thi kiểm tra ẩn toàn lượng ngay');
            runFullHideCheck(); // Thực thi trực tiếp, không debounce, bảo đảm dữ liệu mới nhất
        } else {
            Logger.debug('📢【Sự kiện】Tiện ích chưa bật, bỏ qua kiểm tra ẩn');
        }
        Logger.debug('');
    });

    const handleNewMessage = (eventType) => {
        const context = getContextOptimized();
        const chatLength = context?.chat?.length || 0;
        Logger.debug('');
        Logger.debug(`📨【Sự kiện】${eventType} - Sự kiện tin nhắn mới`);
        Logger.debug(`📨【Sự kiện】   Độ dài chat hiện tại: ${chatLength}`);

        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('📨【Sự kiện】Tiện ích đang bật, thực thi kiểm tra ẩn tăng dần sau 100ms');
            setTimeout(() => runIncrementalHideCheck(), 100);
        } else {
            Logger.debug('📨【Sự kiện】Tiện ích chưa bật, bỏ qua kiểm tra ẩn');
        }
        Logger.debug('');
    };
    eventSource.on(event_types.MESSAGE_RECEIVED, () => handleNewMessage(event_types.MESSAGE_RECEIVED));
    eventSource.on(event_types.MESSAGE_SENT, () => handleNewMessage(event_types.MESSAGE_SENT));

    eventSource.on(event_types.MESSAGE_DELETED, () => {
        Logger.debug('');
        Logger.debug('🗑️【Sự kiện】MESSAGE_DELETED - Tin nhắn đã bị xóa');
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🗑️【Sự kiện】Tiện ích đang bật, thực thi kiểm tra ẩn toàn lượng');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🗑️【Sự kiện】Tiện ích chưa bật, bỏ qua kiểm tra ẩn');
        }
        Logger.debug('');
    });

    // Sự kiện kết thúc quá trình tạo văn bản, bảo đảm tính nhất quán sau cùng
    const streamEndEvent = event_types.GENERATION_ENDED;
    eventSource.on(streamEndEvent, () => {
        Logger.debug('');
        Logger.debug('🏁【Sự kiện】GENERATION_ENDED - Quá trình tạo đã kết thúc');
        // Chạy một lần kiểm tra toàn diện để sửa chữa bất kỳ vấn đề nào phát sinh trong quá trình cập nhật tăng dần
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🏁【Sự kiện】Tiện ích đang bật, thực thi kiểm tra toàn lượng để đảm bảo tính nhất quán');
            runFullHideCheckDebounced();
        } else {
            Logger.debug('🏁【Sự kiện】Tiện ích chưa bật, bỏ qua kiểm tra ẩn');
        }
        Logger.debug('');
    });

    // ============================================================
    // Ngăn chặn thao tác trên popup làm đóng panel extensions của SillyTavern phía sau
    // ============================================================
    const overlay = document.getElementById('hide-helper-modal-overlay');
    if (overlay) {
        const stopPropagation = (e) => { e.stopPropagation(); };
        overlay.addEventListener('mousedown', stopPropagation);
        overlay.addEventListener('touchstart', stopPropagation);
        overlay.addEventListener('click', stopPropagation);
        overlay.addEventListener('wheel', stopPropagation, { passive: true });
    }

    Logger.debug('Thiết lập bộ lắng nghe sự kiện hoàn tất');
}

// Khởi tạo tiện ích mở rộng
jQuery(async () => {
    Logger.info('Bắt đầu khởi tạo tiện ích mở rộng (jQuery ready)...');

    // Cờ đánh dấu đảm bảo khởi tạo chỉ chạy duy nhất một lần
    let isInitialized = false;
    const initializeExtension = () => {
        if (isInitialized) {
            Logger.info('Khởi tạo đã chạy trước đó, bỏ qua');
            return;
        }
        isInitialized = true;
        Logger.info('Kích hoạt bởi sự kiện app_ready, đang chạy các tác vụ khởi tạo');

        // --- Mã nguồn vốn nằm trong setTimeout trước đây ---
        // 1. Tải cài đặt và kích hoạt kiểm tra di chuyển dữ liệu
        loadSettings();

        // 🌟【Sửa lỗi cốt lõi】Cưỡng chế trấn áp hành vi tự ý reset số tầng tải của SillyTavern trên điện thoại
        const settings = extension_settings[extensionName];
        if (settings.limiter_isEnabled && settings.limiter_saved_count > 0) {
            // Nếu giá trị tầng dưới hiện tại không khớp với biến bóng đã lưu (ví dụ bị bản mobile tự ý đổi thành 20)
            if (power_user.chat_truncation !== settings.limiter_saved_count) {
                Logger.warn(`Phát hiện số lượng tải tầng dưới (${power_user.chat_truncation}) bị can thiệp trái phép, cưỡng chế khôi phục về giá trị đã đặt: ${settings.limiter_saved_count}`);
                // Cưỡng chế ghi đè biến tầng dưới
                power_user.chat_truncation = settings.limiter_saved_count;
                // Cưỡng chế ghi đè DOM
                if ($('#chat_truncation').length) {
                    $('#chat_truncation').val(settings.limiter_saved_count);
                    $('#chat_truncation_counter').val(settings.limiter_saved_count);
                }
                // Yêu cầu SillyTavern lưu lại settings.json
                saveSettingsDebounced();
            }
        }

        // 2. Tạo UI (Hiện phụ thuộc vào loadSettings hoàn tất khởi tạo và kiểm tra di chuyển dữ liệu)
        createUI();

        // 2.5 Khởi tạo kiểm tra cập nhật
        initUpdateCheck().then(updateInfo => {
            if (updateInfo) {
                updateVersionDisplay(updateInfo);
            }
        });

        // 3. Cập nhật trạng thái UI ban đầu
        Logger.debug('Cài đặt ban đầu: Thiết lập hiển thị công tắc toàn cục');
        $('#hide-helper-toggle').val(extension_settings[extensionName]?.enabled ? 'enabled' : 'disabled');

        // Áp dụng giao diện đã lưu
        applyTheme(settings.theme || 'light');

        // Áp dụng mức độ nhật ký đã lưu
        applyLogLevel(settings.logLevel || 0);

        // Kiểm tra xem UI nhật ký có vượt quá giới hạn tự ngắt 60 phút hay không (buộc đóng xuyên suốt các phiên)
        if (settings.logUiVisible) {
            const LOG_UI_TIMEOUT = 60 * 60 * 1000;
            if (!settings.logUiOpenedAt) {
                // Nâng cấp từ bản cũ: logUiOpenedAt bị thiếu, không thể xác định thời điểm bật, cưỡng chế tắt
                Logger.warn('Thiếu mốc thời gian mở UI nhật ký (Nâng cấp từ bản cũ), cưỡng chế tắt khi khởi tạo');
                disableLogUi();
            } else if (Date.now() - settings.logUiOpenedAt >= LOG_UI_TIMEOUT) {
                Logger.warn('UI nhật ký đã vượt quá giới hạn tự ngắt 60 phút, cưỡng chế tắt khi khởi tạo');
                disableLogUi();
            }
        }

        Logger.debug('Cài đặt ban đầu: Cập nhật hiển thị cài đặt ẩn hiện tại');
        updateCurrentHideSettingsDisplay();

        // 4. Thực thi kiểm tra toàn lượng khi tải lần đầu (nếu tiện ích bật và thực thể hiện tại đã được người dùng cấu hình)
        if (extension_settings[extensionName]?.enabled) {
            Logger.debug('🎬【Khởi tạo】Tiện ích đang bật, kiểm tra xem có cần chạy kiểm tra toàn lượng ban đầu không');
            const initialSettings = getCurrentHideSettings();
            Logger.debug('🎬【Khởi tạo】Cài đặt ban đầu của thực thể hiện tại:', initialSettings);
            if(initialSettings?.userConfigured === true) {
                Logger.debug('🎬【Khởi tạo】✅ Tìm thấy cấu hình người dùng (N=' + initialSettings.hideLastN + '), đang chạy kiểm tra ẩn toàn lượng ban đầu');
                runFullHideCheck(); // Chạy trực tiếp, không debounce
            } else {
                Logger.debug('🎬【Khởi tạo】⛔ Không tìm thấy cấu hình người dùng (userConfigured=false), bỏ qua kiểm tra toàn lượng ban đầu');
                Logger.debug('🎬【Khởi tạo】💡 Gợi ý: Vui lòng đặt "Số tầng giữ lại N" trong popup để bật tính năng tự động ẩn');
            }
        } else {
            Logger.debug('🎬【Khởi tạo】⛔ Tiện ích đã bị tắt, bỏ qua kiểm tra toàn lượng ban đầu');
        }
        Logger.debug('🎬【Khởi tạo】✨ Hoàn tất tác vụ cài đặt ban đầu');
        Logger.debug('');
        // --- Kết thúc phần mã nguồn trong setTimeout ---
    };

    // Kiểm tra xem kiểu sự kiện app_ready có tồn tại không
    // Đảm bảo cả eventSource và event_types đều đã được tải
    if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined' && event_types.APP_READY) {
        Logger.info(`Đang đợi sự kiện '${event_types.APP_READY}' để khởi tạo...`);
        eventSource.on(event_types.APP_READY, initializeExtension);
    } else {
        // Phương án dự phòng: Nếu không có sự kiện app_ready hoặc eventSource/event_types tải thất bại
        Logger.error('Lỗi nghiêm trọng: Không tìm thấy sự kiện APP_READY hoặc eventSource/event_types chưa được định nghĩa. Quay về chờ 2 giây');
        const initialDelay = 2000;
        Logger.warn(`Lên lịch khởi tạo ban đầu với độ trễ ${initialDelay}ms (Phương án dự phòng)`);
        setTimeout(initializeExtension, initialDelay); // Dùng lại chính hàm initializeExtension làm fallback
    }
});

// Chốt chặn đánh chặn cuối cùng: Cắt đứt trực tiếp mảng chat trước khi gửi request API, đảm bảo chỉ có N tin nhắn mới nhất được gửi đi
globalThis.HideHelper_interceptGeneration = function (chat) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;

    const autoHideEnabled = settings.autoHideEnabled ?? true;
    if (!autoHideEnabled) return;

    const hideSettings = getCurrentHideSettings();
    if (!hideSettings?.userConfigured || !hideSettings.hideLastN || hideSettings.hideLastN <= 0) return;

    const originalLength = chat.length;
    const targetLength = hideSettings.hideLastN;

    if (originalLength > targetLength) {
        const removedCount = originalLength - targetLength;
        Logger.warn('');
        Logger.warn('🛡️【Đánh chặn yêu cầu】Kích hoạt cơ chế bảo vệ chốt chặn cuối cùng');
        Logger.warn(`🛡️【Đánh chặn yêu cầu】⚠️ Phát hiện độ dài mảng chat (${originalLength}) vượt quá giá trị giữ lại (${targetLength})`);
        Logger.warn(`🛡️【Đánh chặn yêu cầu】🔪 Cưỡng chế xóa ${removedCount} tin nhắn đầu tiên, đảm bảo chỉ gửi ${targetLength} tin mới nhất`);

        while (chat.length > targetLength) {
            chat.shift();
        }

        Logger.warn(`🛡️【Đánh chặn yêu cầu】✅ Đánh chặn hoàn tất, mảng chat đã bị cắt ngắn từ ${originalLength} còn ${chat.length}`);
        Logger.warn(`🛡️【Đánh chặn yêu cầu】💡 Điều này cho thấy cơ chế ẩn phía trước có thể đã mất hiệu lực, lớp đánh chặn này đóng vai trò như lá chắn phòng thủ cuối`);
        Logger.warn('');
    }
};