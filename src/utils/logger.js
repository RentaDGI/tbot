const { createClient } = require('@supabase/supabase-js');

class Logger {
    constructor() {
        this.supabase = null;
        this.accountId = null;
    }

    init(supabaseClient, accountId) {
        this.supabase = supabaseClient;
        this.accountId = accountId;
    }

    async log(action, details = {}, severity = 'info') {
        const timestamp = new Date().toISOString();
        const prefix = this.getPrefix(severity);
        
        // Console log
        console.log(`${prefix} [${timestamp.split('T')[1].split('.')[0]}] ${action}`, 
            Object.keys(details).length > 0 ? JSON.stringify(details) : '');

        // Database log (si está conectado)
        if (this.supabase && this.accountId) {
            try {
                await this.supabase.from('bot_logs').insert({
                    account_id: this.accountId,
                    action,
                    details,
                    severity
                });
            } catch (err) {
                console.error('Error guardando log:', err.message);
            }
        }
    }

    getPrefix(severity) {
        const prefixes = {
            debug: '🔍',
            info: 'ℹ️ ',
            warn: '⚠️ ',
            error: '❌',
            success: '✅'
        };
        return prefixes[severity] || 'ℹ️ ';
    }

    debug(action, details) { return this.log(action, details, 'debug'); }
    info(action, details) { return this.log(action, details, 'info'); }
    warn(action, details) { return this.log(action, details, 'warn'); }
    error(action, details) { return this.log(action, details, 'error'); }
    success(action, details) { return this.log(action, details, 'success'); }
}

module.exports = new Logger();