const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { humanDelay, sleep } = require('../utils/time');
const logger = require('../utils/logger');

const SESSION_PATH = path.resolve(__dirname, '../../session.json');
const BUILDING_KEYWORDS = {
    barracks: ['cuartel', 'barracks'],
    stable: ['establo', 'stable'],
    workshop: ['taller', 'workshop'],
    residence: ['residencia', 'palacio', 'residence', 'palace']
};

class GameClient {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        this.fieldCache = null;
        this.lastScanTime = null;
        this.CACHE_DURATION = 30 * 60 * 1000;
    }

    async init() {
        logger.info('Iniciando navegador...');
        this.browser = await chromium.launch({
            headless: process.env.HEADLESS === 'true',
            args: ['--disable-blink-features=AutomationControlled', '--disable-infobars', '--window-size=1366,768']
        });

        const contextOptions = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1366, height: 768 },
            locale: 'es-ES'
        };

        if (fs.existsSync(SESSION_PATH)) {
            logger.info('ðŸ“‚ Cargando sesiÃ³n guardada...');
            try {
                contextOptions.storageState = SESSION_PATH;
            } catch (e) {
                logger.warn('Archivo de sesiÃ³n corrupto.');
            }
        }

        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
    }

    async login() {
        const url = process.env.GAME_URL;
        logger.info('Navegando al juego...');
        
        try {
            await this.page.goto(url, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 3000, 5000);

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… SesiÃ³n vÃ¡lida. Login saltado.');
                this.isLoggedIn = true;
                return true;
            }

            logger.info('ðŸ”‘ Iniciando sesiÃ³n manual...');
            const userField = await this.page.$('input[name="name"], input[name="username"]');
            if (userField) {
                await userField.fill(process.env.GAME_USERNAME);
                await humanDelay(this.page, 300, 600);
                await this.page.fill('input[name="password"]', process.env.GAME_PASSWORD);
                await humanDelay(this.page, 500, 1000);
                
                const btn = await this.page.$('button[type="submit"], input[type="submit"]');
                if (btn) {
                    await btn.click();
                    logger.info('   Esperando carga tras login...');
                    await humanDelay(this.page, 5000, 7000);
                }
            }

            if (await this.checkIfLoggedIn()) {
                logger.success('âœ… Login exitoso. Guardando sesiÃ³n...');
                this.isLoggedIn = true;
                await this.context.storageState({ path: SESSION_PATH });
                return true;
            } else {
                throw new Error('Fallo al iniciar sesiÃ³n.');
            }
        } catch (error) {
            if (!this.page.isClosed()) await this.page.screenshot({ path: 'error-login.png' });
            throw error;
        }
    }

    async checkIfLoggedIn() {
        if (this.page.isClosed()) return false;
        return !!(await this.page.$('#stockBar, .villageList, #sidebarBoxVillagelist, a[href*="logout"], .playerName'));
    }

    async clickBuildingSlot(slotId) {
        if (this.page.isClosed()) return;
        await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slotId}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1500, 2500);
    }

    async findBuildingSlot(buildingType, explicitSlot) {
        if (explicitSlot) return explicitSlot;
        const keywords = (BUILDING_KEYWORDS[buildingType] || [buildingType]).filter(Boolean);
        if (!keywords.length) return null;

        const tryReadSlotFromPage = async () => {
            try {
                await this.page.goto(`${process.env.GAME_URL}/dorf2.php`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 900, 1400);
            } catch (error) {
                logger.warn('No se pudo abrir dorf2 para localizar edificio: ' + error.message);
                return null;
            }

            return await this.page.evaluate(({ keywords }) => {
                const normalize = (text) => (text || '')
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .trim();

                const targets = keywords.map(normalize);

                const nodes = Array.from(document.querySelectorAll('area[href*="build.php?id="], a[href*="build.php?id="], [href*="build.php?id="]'));
                for (const el of nodes) {
                    const href = el.getAttribute('href') || '';
                    const match = href.match(/id=(\d+)/);
                    if (!match) continue;
                    const label = normalize(el.getAttribute('title') || el.getAttribute('alt') || el.textContent || '');
                    if (targets.some(key => label.includes(key))) {
                        return parseInt(match[1], 10);
                    }
                }

                const labels = Array.from(document.querySelectorAll('.buildingSlot, .label'));
                for (const el of labels) {
                    const link = el.querySelector('a[href*="build.php?id="]');
                    if (!link) continue;
                    const href = link.getAttribute('href') || '';
                    const match = href.match(/id=(\d+)/);
                    if (!match) continue;
                    const label = normalize(el.textContent || link.getAttribute('title') || '');
                    if (targets.some(key => label.includes(key))) {
                        return parseInt(match[1], 10);
                    }
                }

                return null;
            }, { keywords });
        };

        let slot = await tryReadSlotFromPage();
        if (slot) return slot;

        // Fallback: probar slots tÃ­picos de cada edificio
        const fallbackSlots = {
            barracks: [19],
            stable: [20],
            workshop: [21, 22],
            residence: [25, 26]
        };

        const candidates = fallbackSlots[buildingType] || [];
        for (const candidate of candidates) {
            try {
                await this.page.goto(`${process.env.GAME_URL}/build.php?id=${candidate}`, { waitUntil: 'domcontentloaded' });
                await humanDelay(this.page, 600, 900);
                const matches = await this.page.evaluate(({ keywords }) => {
                    const normalize = (text) => (text || '')
                        .toLowerCase()
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .trim();
                    const titleEl = document.querySelector('.titleInHeader, h1');
                    const text = titleEl ? normalize(titleEl.textContent) : '';
                    return keywords.some(key => text.includes(normalize(key)));
                }, { keywords });
                if (matches) return candidate;
            } catch (error) {
                logger.warn(`No se pudo probar slot ${candidate}: ${error.message}`);
            }
        }

        return null;
    }

    /**
     * ESCÃNER 1-A-1 BLINDADO ("Todo o Nada")
     */
    async scanSlotsOneByOne() {
        logger.info('ðŸ” Escaneando campos uno a uno...');
        const fields = [];
        
        for (let slot = 1; slot <= 18; slot++) {
            try {
                if (this.page.isClosed()) break;
                
                await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                await this.page.waitForTimeout(200); // PequeÃ±a espera

                // 1. Obtener Info
                const info = await this.getBuildingInfo();

                // 2. Detectar ConstrucciÃ³n
                const isUnderConstruction = await this.page.evaluate((currentSlot) => {
                    const queueBox = document.querySelector('.buildingList, .boxes-contents');
                    if (!queueBox) return false;
                    const links = queueBox.querySelectorAll('a');
                    for (const link of links) {
                        const href = link.getAttribute('href') || '';
                        if (href.includes(`id=${currentSlot}`)) {
                            const match = href.match(/id=(\d+)/);
                            if (match && parseInt(match[1]) === currentSlot) return true;
                        }
                    }
                    return false;
                }, slot);

                if (info.name) {
                    const name = info.name.toLowerCase();
                    let type = null;
                    if (name.includes('leÃ±a') || name.includes('wood') || name.includes('bosque')) type = 'wood';
                    else if (name.includes('barr') || name.includes('clay') || name.includes('arcilla')) type = 'clay';
                    else if (name.includes('hierro') || name.includes('iron') || name.includes('mina')) type = 'iron';
                    else if (name.includes('granja') || name.includes('crop') || name.includes('cereal')) type = 'crop';

                    if (type) {
                        const effectiveLevel = isUnderConstruction ? info.level + 1 : info.level;
                        fields.push({ slot, type, level: effectiveLevel });
                        if (process.env.DEBUG === 'true') {
                            const status = isUnderConstruction ? '(ðŸ”¨)' : '';
                            console.log(`   Slot ${slot}: ${type} ${info.level} ${status}`);
                        }
                    }
                }
            } catch (e) {
                logger.warn(`âš ï¸ Error leyendo slot ${slot}, reintentando...`);
                // Si falla un slot, no lo aÃ±adimos a fields.
            }
        }

        // === SEGURIDAD "TODO O NADA" ===
        // Si no hemos leÃ­do exactamente 18 campos, el escÃ¡ner ha fallado parcialmente.
        // Si devolvemos una lista incompleta, el bot puede pensar que ya terminÃ³ tareas que no ha visto.
        if (fields.length < 18) {
            logger.error(`â›” ALERTA: EscÃ¡ner incompleto (${fields.length}/18). Abortando para evitar errores.`);
            throw new Error('SCAN_INCOMPLETE_RETRY');
        }

        this.fieldCache = fields;
        this.lastScanTime = Date.now();
        this.logCacheStatus();
        return fields;
    }

    async scanFieldsIfNeeded(forceRescan = false) {
        const cacheValid = this.fieldCache && this.lastScanTime && (Date.now() - this.lastScanTime < this.CACHE_DURATION);
        if (cacheValid && !forceRescan) {
            logger.info('Usando cache de campos (vÃ¡lida)');
            return this.fieldCache;
        }
        return await this.scanSlotsOneByOne();
    }

    updateFieldLevel(slot, incrementLevel = true) {
        if (!this.fieldCache) return;
        for (const field of this.fieldCache) {
            if (field.slot === slot) {
                if (incrementLevel) field.level += 1;
                field.isBuilding = true;
                logger.info(`Cache actualizada: Slot ${slot} -> Nivel ${field.level}`);
                break;
            }
        }
    }

    findLowestFieldAcrossAllTasks(tasks, resourceAmounts = {}) {
        if (!this.fieldCache) return null;
        const resourceTasks = tasks.filter(task => task.building_type);
        if (!resourceTasks.length) return null;

        const allCandidates = [];

        for (const task of resourceTasks) {
            for (const field of this.fieldCache) {
                if (field.type === task.building_type &&
                    field.level < task.target_level &&
                    !field.isBuilding) {
                    const resourceValue = typeof resourceAmounts[field.type] === 'number'
                        ? resourceAmounts[field.type]
                        : Number.MAX_SAFE_INTEGER;
                    allCandidates.push({
                        slot: field.slot,
                        type: field.type,
                        level: field.level,
                        task,
                        targetLevel: task.target_level,
                        resourceValue
                    });
                }
            }
        }

        if (!allCandidates.length) return null;

        allCandidates.sort((a, b) => {
            if (a.level !== b.level) return a.level - b.level;
            return a.resourceValue - b.resourceValue;
        });

        const winner = allCandidates[0];
        logger.info(`Campo mÃ¡s bajo: ${winner.task.building_name} Slot ${winner.slot} (Nivel ${winner.level})`);
        return winner;
    }

    getCompletedResourceTasks(tasks) {
        if (!this.fieldCache) return [];
        return tasks.filter(task => {
            if (!task.building_type) return false;
            const fieldsOfType = this.fieldCache.filter(field => field.type === task.building_type);
            if (!fieldsOfType.length) return false;
            return fieldsOfType.every(field => field.level >= task.target_level);
        });
    }

    invalidateCache() {
        this.fieldCache = null;
        this.lastScanTime = null;
        logger.info('Cache de campos invalidada.');
    }

    logCacheStatus() {
        if (!this.fieldCache || !this.fieldCache.length) return;
        const summary = {};
        for (const field of this.fieldCache) {
            if (!summary[field.type]) {
                summary[field.type] = { count: 0, levels: [], building: 0 };
            }
            summary[field.type].count += 1;
            summary[field.type].levels.push(field.level);
            if (field.isBuilding) summary[field.type].building += 1;
        }
        logger.info('Estado de campos:');
        for (const type of Object.keys(summary)) {
            const data = summary[type];
            const minLevel = Math.min(...data.levels);
            const maxLevel = Math.max(...data.levels);
            logger.info(`   ${type}: ${data.count} campos, niveles ${minLevel}-${maxLevel}${data.building ? ` (${data.building} en cola)` : ''}`);
        }
    }

    async findLowestLevelField(buildingType, maxLevel) {
        // Usamos SIEMPRE el escÃ¡ner lento.
        const fields = await this.scanSlotsOneByOne();
        
        // VerificaciÃ³n extra de seguridad
        const typeCount = fields.filter(f => f.type === buildingType).length;
        if (typeCount === 0) {
            throw new Error(`SCAN_FAILED: No se encontraron campos de tipo ${buildingType}`);
        }

        const eligible = fields.filter(f => f.type === buildingType && f.level < maxLevel)
                               .sort((a, b) => a.level - b.level);
        
        return eligible.length > 0 ? eligible[0] : null;
    }

    async checkAndStartAdventure() {
        if (this.page.isClosed()) return false;
        logger.info('ðŸ—ºï¸ Revisando aventuras...');

        try {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 2000, 3000);

            const health = await this.getHeroHealthPercent({ skipNavigation: true });
            if (health < 30) {
                logger.warn(`ðŸš‘ Salud baja (${health}%). Cancelando.`);
                return false;
            }

            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button.green, .adventureList button'));
                for (const btn of buttons) {
                    const text = (btn.innerText || btn.value || '').toLowerCase().trim();
                    if (text.includes('explorar') || text.includes('comenzar') || text.includes('start')) {
                        if (btn.disabled || btn.classList.contains('disabled')) return { found: true, canClick: false };
                        btn.click();
                        return { found: true, canClick: true };
                    }
                }
                return { found: false };
            });

            if (result.canClick) {
                logger.success('âš”ï¸ Â¡HÃ©roe enviado!');
                await humanDelay(this.page, 2000, 3000);
                return true;
            } else {
                logger.info('Sin aventuras disponibles.');
            }
        } catch (error) {
            logger.warn('Error en aventuras:', error.message);
        }
        return false;
    }

    async checkAndRaidOases(oasisTargets, options = {}) {
        if (this.page.isClosed()) return false;

        try {
            const health = await this.getHeroHealthPercent();
            logger.info(`Salud actual del heroe: ${health}%. No se aplicara filtro de salud.`);

            const targets = [...oasisTargets];
            targets.sort(() => Math.random() - 0.5);

            for (const oasis of targets) {
                const troops = await this.inspectOasisNatureTroops(oasis);
                if (troops === null) {
                    logger.warn(`No se pudo leer las tropas de la naturaleza para el oasis (${oasis.x}|${oasis.y}).`);
                    continue;
                }

                logger.info(`Oasis (${oasis.x}|${oasis.y}) - Tropas de la naturaleza: ${troops}`);
                if (troops >= 1 && troops < 20) {
                    const sendResult = await this.sendHeroFromCurrentOasis();
                    if (sendResult.success) {
                        logger.success(`Heroe enviado al oasis (${oasis.x}|${oasis.y}) con ${troops} tropas.`);
                        return true;
                    } else {
                        logger.warn(`No se pudo enviar el heroe al oasis (${oasis.x}|${oasis.y}): ${sendResult.reason}`);
                    }
                }
            }
        } catch (error) {
            logger.warn('Error al revisar oasis: ' + error.message);
        }

        return false;
    }

    async getHeroHealthPercent(options = {}) {
        if (this.page.isClosed()) return 0;
        if (!options.skipNavigation) {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1500, 2500);
        }

        return await this.page.evaluate(() => {
            function extractNumber(text) {
                if (!text) return null;
                const percentMatch = text.match(/(\d{1,3})\s*%/);
                if (percentMatch) return parseInt(percentMatch[1], 10);
                const numberMatch = text.match(/(\d{1,3})/);
                return numberMatch ? parseInt(numberMatch[1], 10) : null;
            }

            const bar = document.querySelector('.heroHealthBar .bar');
            if (bar) {
                const width = bar.style.width || bar.getAttribute('style') || '';
                const match = width.match(/(\d{1,3})/);
                if (match) return Math.min(100, Math.max(0, parseInt(match[1], 10)));
            }

            const heroSection = document.querySelector('.heroHealthBar, .heroStats, .heroAttributes');
            const heroText = heroSection ? heroSection.innerText : '';
            const parsedFromText = extractNumber(heroText);
            if (parsedFromText !== null) return Math.min(100, Math.max(0, parsedFromText));

            const valueNode = document.querySelector('.heroHealthBar .value');
            return extractNumber(valueNode ? valueNode.innerText : '') || 0;
        });
    }

    async inspectOasisNatureTroops(oasis) {
        if (this.page.isClosed()) return null;

        await this.page.goto(`${process.env.GAME_URL}/karte.php?x=${oasis.x}&y=${oasis.y}`, { waitUntil: 'domcontentloaded' });
        await humanDelay(this.page, 1200, 2200);

        return await this.page.evaluate(() => {
            const text = document.body ? document.body.innerText : '';
            if (!text) return null;

            const patterns = [
                /Tropas de la naturaleza[^\d]*(\d+)/i,
                /Nature troops[^\d]*(\d+)/i,
                /Naturtruppen[^\d]*(\d+)/i,
                /Nature block[^\d]*(\d+)/i
            ];

            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match) return parseInt(match[1], 10);
            }

            const fallback = text.match(/(\d+)\s*(?:nature troops|tropas de la naturaleza)/i);
            if (fallback) return parseInt(fallback[1], 10);
            return null;
        });
    }

    async sendHeroFromCurrentOasis() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const result = await this.page.evaluate(() => {
            const findHeroInput = () => {
                const selectors = ['input[name*="hero"]', 'input[id*="hero"]'];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el) return el;
                }
                const inputs = document.querySelectorAll('input[type="text"], input[type="number"]');
                for (const input of inputs) {
                    const descriptor = (input.name || input.id || input.placeholder || '').toLowerCase();
                    if (descriptor.includes('heroe') || descriptor.includes('hero')) {
                        return input;
                    }
                }
                return null;
            };

            const heroInput = findHeroInput();
            if (!heroInput) return { success: false, reason: 'hero_input_not_found' };
            if (heroInput.disabled) return { success: false, reason: 'hero_input_disabled' };

            heroInput.value = 1;
            heroInput.dispatchEvent(new Event('input', { bubbles: true }));
            heroInput.dispatchEvent(new Event('change', { bubbles: true }));

            const form = heroInput.closest('form') || heroInput.form;
            if (!form) return { success: false, reason: 'form_not_found' };

            const otherInputs = form.querySelectorAll('input[type="text"], input[type="number"]');
            for (const input of otherInputs) {
                if (input === heroInput) continue;
                input.value = 0;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
            const candidate = buttons.find(btn => {
                if (btn.disabled) return false;
                const label = (btn.innerText || btn.value || '').toLowerCase();
                return label.includes('atacar') || label.includes('enviar') || label.includes('attack') || label.includes('send');
            }) || buttons[0];

            if (!candidate) return { success: false, reason: 'submit_button_not_found' };
            if (candidate.disabled) return { success: false, reason: 'submit_button_disabled' };
            candidate.click();
            return { success: true };
        });

        if (result.success) {
            await humanDelay(this.page, 1500, 2200);
        }

        return result;
    }

    async getResourceAmounts() {
        if (this.page.isClosed()) return null;

        try {
            await this.page.goto(`${process.env.GAME_URL}/dorf1.php`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1000, 1600);
        } catch (error) {
            logger.warn('No se pudo visitar Dorf1 para leer recursos: ' + error.message);
            return null;
        }

        return await this.page.evaluate(() => {
            function parseAmount(raw) {
                if (!raw) return null;
                const cleaned = raw.replace(/[\\.\\,\\s]/g, '').replace(/[^0-9]/g, '');
                return cleaned ? parseInt(cleaned, 10) : null;
            }

            const stockBar = document.querySelector('#stockBar');
            const fallbackText = stockBar ? stockBar.innerText : document.body.innerText;
            const variants = {
                wood: ['madera', 'wood', 'holz'],
                clay: ['barro', 'clay', 'lehm', 'arcilla'],
                iron: ['hierro', 'iron', 'eisen', 'mineral'],
                crop: ['cereal', 'crop', 'trigo', 'gran']
            };

            const resources = {};
            for (const type in variants) {
                for (const label of variants[type]) {
                    const regex = new RegExp(label + '[^\\d]*(\\d[\\d\\.\\,]*)\\s*', 'i');
                    const match = fallbackText.match(regex);
                    if (match) {
                        const amount = parseAmount(match[1]);
                        if (amount !== null) {
                            resources[type] = amount;
                            break;
                        }
                    }
                }
            }

            return Object.keys(resources).length ? resources : null;
        });
    }

    async upgradeBuild() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };
        
        logger.info('Buscando botÃ³n de mejora...');
        const result = await this.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button.green'));
            for (const btn of buttons) {
                const text = btn.innerText.toLowerCase();
                const classes = btn.className.toLowerCase();
                if (classes.includes('gold')) continue;
                if (text.includes('npc') || text.includes('intercambiar')) continue;
                if (btn.disabled || classes.includes('disabled')) continue;
                btn.click();
                return { success: true };
            }
            if (document.querySelector('.queueFull, .buildingQueueFull')) return { success: false, reason: 'queue_full' };
            return { success: false, reason: 'not_enough_resources' };
        });

        if (result.success) {
            await humanDelay(this.page, 2000, 3000);
            return { success: true };
        }
        return { success: false, reason: result.reason };
    }

    async executeTraining(buildingType, troopIdentifier, quantity = -1, buildingSlot = null) {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };

        const slot = await this.findBuildingSlot(buildingType, buildingSlot);
        if (!slot) return { success: false, reason: 'building_not_found' };

        try {
            await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 1200, 2000);
        } catch (error) {
            logger.warn('No se pudo abrir la pagina de entrenamiento: ' + error.message);
            return { success: false, reason: 'navigation_failed' };
        }

        const result = await this.page.evaluate(({ identifier, quantity }) => {
            const normalize = (text) => (text || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .trim();

            const identifierIsNumber = typeof identifier === 'number' || (typeof identifier === 'string' && /^\d+$/.test(identifier));
            const targetIndex = identifierIsNumber ? parseInt(identifier, 10) : null;
            const targetName = identifierIsNumber ? null : normalize(identifier);

            const rows = Array.from(document.querySelectorAll('form table tr, .trainUnits tr, .textList .unit, .unitWrapper'))
                .filter(row => row.querySelector('input[name^="t"]'));

            const pickQuantity = (row, input) => {
                if (quantity !== -1) return quantity;

                const maxAttr = input.getAttribute('max');
                if (maxAttr && !isNaN(parseInt(maxAttr, 10))) return parseInt(maxAttr, 10);

                const maxNode = row.querySelector('.max, a.max');
                if (maxNode) {
                    const match = maxNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                const valueNode = row.querySelector('.value, .maxValue');
                if (valueNode) {
                    const match = valueNode.innerText.match(/(\d+)/);
                    if (match) return parseInt(match[1], 10);
                }

                return 0;
            };

            for (const row of rows) {
                const input = row.querySelector('input[name^="t"]');
                if (!input) continue;

                const inputName = input.getAttribute('name') || '';
                const indexMatch = inputName.match(/t(\d+)/);
                const troopIndex = indexMatch ? parseInt(indexMatch[1], 10) : null;
                const rowText = normalize(row.innerText);

                const matches = targetIndex !== null
                    ? troopIndex === targetIndex
                    : rowText.includes(targetName);

                if (!matches) continue;

                const qty = pickQuantity(row, input);
                if (!qty || qty <= 0) {
                    return { success: false, reason: 'not_enough_resources' };
                }

                input.value = qty;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));

                const form = input.closest('form') || document.querySelector('form[action*="train"]');
                if (!form) return { success: false, reason: 'form_not_found' };

                const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
                const btn = buttons.find(b => {
                    if (b.disabled) return false;
                    const label = normalize(b.innerText || b.value || '');
                    return label.includes('entrenar') || label.includes('train') || label.includes('reclutar') || label.includes('enviar');
                }) || buttons.find(b => !b.disabled);

                if (!btn) return { success: false, reason: 'submit_button_not_found' };
                btn.click();
                return { success: true, trained: qty };
            }

            return { success: false, reason: 'troop_not_found' };
        }, { identifier: troopIdentifier, quantity });

        if (!result.success) return result;

        await humanDelay(this.page, 1600, 2400);
        return result;
    }

    async getBuildingInfo() {
        if (this.page.isClosed()) return {};
        return await this.page.evaluate(() => {
            const titleEl = document.querySelector('.titleInHeader, h1');
            if (!titleEl) return {};
            const text = titleEl.textContent;
            const levelMatch = text.match(/(\d+)/);
            return {
                name: text.replace(/\d+/, '').trim(),
                level: levelMatch ? parseInt(levelMatch[0]) : 0
            };
        });
    }

    async screenshot(filename) {
        if (this.page && !this.page.isClosed()) await this.page.screenshot({ path: filename });
    }

    async close() {
        if (this.browser) await this.browser.close();
    }
}

module.exports = GameClient;



