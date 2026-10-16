// Logger.js
const PREFIX = '%c[Trợ lý ẩn tầng]';
const BASE_STYLE = 'font-weight: bold; padding: 2px 4px; border-radius: 3px; margin-right: 4px;';

const STYLES = {
    info:    `${BASE_STYLE} color: white; background-color: #17a2b8;`, // Xanh dương - Thông tin chung
    success: `${BASE_STYLE} color: white; background-color: #28a745;`, // Xanh lá - Thao tác thành công
    warn:    `${BASE_STYLE} color: #333; background-color: #ffc107;`,  // Vàng cam - Cảnh báo
    error:   `${BASE_STYLE} color: white; background-color: #dc3545;`, // Đỏ - Lỗi
    debug:   `${BASE_STYLE} color: #6c757d; background-color: #f8f9fa; border: 1px solid #dee2e6;` // Xám - Gỡ lỗi (Debug)
};

// Định nghĩa mức độ nhật ký (Log Level)
const LogLevel = {
    NONE: 0,      // Tắt log - Không xuất log
    CORE: 1,      // Log cốt lõi - error + warn
    RUNTIME: 2,   // Log hoạt động - error + warn + info + success
    FULL: 3       // Log đầy đủ - Toàn bộ log bao gồm cả debug
};

class Logger {
    // Mức độ nhật ký hiện tại (mặc định là tắt log)
    static currentLevel = LogLevel.NONE;
    // Mảng lưu trữ lịch sử nhật ký, dùng để xuất file
    static logHistory = [];

    // Đẩy log vào bộ nhớ RAM (Giới hạn nghiêm ngặt: Chỉ thực hiện ở mức log đầy đủ cấp 3 để đảm bảo hiệu năng)
    static pushToHistory(levelName, ...args) {
        if (this.currentLevel !== LogLevel.FULL) return;

        const timestamp = new Date().toLocaleString('vi-VN', { hour12: false });
        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg, (key, value) => {
                        if (key === 'parent' || key === 'dom' || key === 'collection') return '[Đã lược bỏ đối tượng lồng nhau]';
                        return value;
                    });
                } catch(e) { return '[Đối tượng phức tạp / Phân tích thất bại]'; }
            }
            return String(arg);
        }).join(' ');

        this.logHistory.push(`[${timestamp}] [${levelName}] ${message}`);

        // Giới hạn bộ nhớ chỉ lưu tối đa 500 dòng log gần nhất
        if (this.logHistory.length > 500) {
            this.logHistory.shift();
        }
    }

    // Xuất và tải xuống file nhật ký
    static exportLogs() {
        if (this.logHistory.length === 0) return false;
        const blob = new Blob([this.logHistory.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `HideHelper_DebugLog_${new Date().getTime()}.log`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    }

    // Thiết lập mức độ nhật ký
    static setLogLevel(level) {
        if (level in LogLevel) {
            this.currentLevel = LogLevel[level];
        } else if (typeof level === 'number' && level >= 0 && level <= 3) {
            this.currentLevel = level;
        }
    }

    // Lấy mức độ nhật ký hiện tại
    static getLogLevel() {
        return this.currentLevel;
    }

    // Kiểm tra xem có nên xuất log hay không
    static shouldLog(level) {
        return this.currentLevel >= level;
    }

    // Thông báo lỗi (Mức 1 - Log cốt lõi)
    static error(...args) {
        this.pushToHistory('ERROR', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.error(PREFIX, STYLES.error, ...args);
    }

    // Thông báo cảnh báo (Mức 1 - Log cốt lõi)
    static warn(...args) {
        this.pushToHistory('WARN', ...args);
        if (this.shouldLog(LogLevel.CORE)) console.warn(PREFIX, STYLES.warn, ...args);
    }

    // Thông tin cơ bản (Mức 2 - Log hoạt động)
    static info(...args) {
        this.pushToHistory('INFO', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, STYLES.info, ...args);
    }

    // Thông báo thành công (Mức 2 - Log hoạt động)
    static success(...args) {
        this.pushToHistory('SUCCESS', ...args);
        if (this.shouldLog(LogLevel.RUNTIME)) console.log(PREFIX, STYLES.success, ...args);
    }

    // Thông tin gỡ lỗi (Mức 3 - Log đầy đủ)
    static debug(...args) {
        this.pushToHistory('DEBUG', ...args);
        if (this.shouldLog(LogLevel.FULL)) console.debug(PREFIX, STYLES.debug, ...args);
    }
}

// Xuất hằng số mức độ nhật ký để sử dụng bên ngoài
Logger.LogLevel = LogLevel;

export default Logger;