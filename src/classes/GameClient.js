const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { humanDelay } = require('../utils/time');
const logger = require('../utils/logger');

const SESSION_PATH = path.resolve(__dirname, '../../session.json');

class GameClient {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLoggedIn = false;
        
        // MEMORIA LOCAL (CACHÉ)
        // Guardará el estado de los campos para no escanear cada vez
        this.resourcesCache = null; 
        this.lastCacheUpdate = 0;
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
            logger.info('📂 Cargando sesión guardada...');
            try {
                contextOptions.storageState = SESSION_PATH;
            } catch (e) {
                logger.warn('Archivo de sesión corrupto.');
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
                logger.success('✅ Sesión válida. Login saltado.');
                this.isLoggedIn = true;
                return true;
            }

            logger.info('🔑 Iniciando sesión manual...');
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
                logger.success('✅ Login exitoso. Guardando sesión...');
                this.isLoggedIn = true;
                await this.context.storageState({ path: SESSION_PATH });
                return true;
            } else {
                throw new Error('Fallo al iniciar sesión.');
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

    /**
     * ESCÁNER INICIAL (Se ejecuta solo una vez al arrancar o cada X horas)
     */
    async buildCache() {
        logger.info('🔄 Creando mapa de recursos en memoria (Solo una vez)...');
        const fields = [];
        
        for (let slot = 1; slot <= 18; slot++) {
            try {
                if (this.page.isClosed()) break;
                
                await this.page.goto(`${process.env.GAME_URL}/build.php?id=${slot}`, { waitUntil: 'domcontentloaded' });
                // Añadimos un poco de aleatoriedad al delay para parecer humano revisando
                await this.page.waitForTimeout(Math.random() * 500 + 200); 

                const info = await this.getBuildingInfo();
                const isUnderConstruction = await this.checkConstruction(slot);

                if (info.name) {
                    const name = info.name.toLowerCase();
                    let type = null;
                    if (name.includes('leña') || name.includes('wood') || name.includes('bosque')) type = 'wood';
                    else if (name.includes('barr') || name.includes('clay') || name.includes('arcilla')) type = 'clay';
                    else if (name.includes('hierro') || name.includes('iron') || name.includes('mina')) type = 'iron';
                    else if (name.includes('granja') || name.includes('crop') || name.includes('cereal')) type = 'crop';

                    if (type) {
                        const effectiveLevel = isUnderConstruction ? info.level + 1 : info.level;
                        fields.push({ slot, type, level: effectiveLevel, isBusy: isUnderConstruction });
                    }
                }
            } catch (e) {}
        }
        
        this.resourcesCache = fields;
        this.lastCacheUpdate = Date.now();
        logger.success(`✅ Mapa de recursos guardado en memoria (${fields.length} campos).`);
    }

    /**
     * Helper para detectar construcción
     */
    async checkConstruction(slotId) {
        return await this.page.evaluate((currentSlot) => {
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
        }, slotId);
    }

    /**
     * LÓGICA OPTIMIZADA: Usa la memoria en vez de navegar
     */
    async findLowestLevelField(buildingType, maxLevel) {
        // 1. Si no hay caché, lo creamos (esto pasa 1 vez)
        if (!this.resourcesCache) {
            await this.buildCache();
        }

        // 2. Buscamos en memoria
        const eligible = this.resourcesCache
            .filter(f => f.type === buildingType && f.level < maxLevel)
            .sort((a, b) => a.level - b.level);

        if (eligible.length === 0) {
            // Si la memoria dice que no hay nada, devolvemos null
            // (Seguridad: si falla mucho, podríamos forzar un rebuildCache)
            return null;
        }

        // 3. Seleccionamos el candidato
        const candidate = eligible[0];

        // 4. VERIFICACIÓN "JUST IN TIME"
        // Antes de decir "ve a este", vamos a ir a ese slot específico y actualizar el caché
        // Esto evita errores si subiste algo manualmente.
        
        // NOTA: Como el TaskRunner va a navegar a ese slot justo después,
        // devolvemos el candidato y dejamos que el TaskRunner navegue.
        // Pero necesitamos un mecanismo para actualizar el caché tras la visita.
        
        return candidate;
    }

    /**
     * ACTUALIZAR CACHÉ PUNTUAL
     * Se llama después de visitar un edificio para construir
     */
    async updateCacheForSlot(slotId) {
        if (!this.resourcesCache) return;

        try {
            const info = await this.getBuildingInfo();
            const isUnderConstruction = await this.checkConstruction(slotId);
            
            // Buscar en caché y actualizar
            const index = this.resourcesCache.findIndex(f => f.slot === slotId);
            if (index !== -1) {
                const effectiveLevel = isUnderConstruction ? info.level + 1 : info.level;
                
                // Actualizamos datos
                this.resourcesCache[index].level = effectiveLevel;
                this.resourcesCache[index].isBusy = isUnderConstruction;
                
                if (process.env.DEBUG) logger.info(`🧠 Memoria actualizada: Slot ${slotId} ahora es Nivel ${effectiveLevel}`);
            }
        } catch(e) {
            logger.warn('No se pudo actualizar caché puntual');
        }
    }

    // ... (Aventuras, Login, Init iguales que antes)
    async checkAndStartAdventure() {
        if (this.page.isClosed()) return false;
        logger.info('🗺️ Revisando aventuras...');

        try {
            await this.page.goto(`${process.env.GAME_URL}/hero/adventures`, { waitUntil: 'domcontentloaded' });
            await humanDelay(this.page, 2000, 3000);

            const health = await this.page.evaluate(() => {
                const bar = document.querySelector('.heroHealthBar .bar');
                return bar ? parseInt(bar.style.width) : 100;
            });

            if (health < 30) {
                logger.warn(`🚑 Salud baja (${health}%). Cancelando.`);
                return false;
            }

            const result = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button.green, .adventureList button'));
                for (const btn of buttons) {
                    const text = btn.innerText.toLowerCase().trim();
                    if (text.includes('explorar') || text.includes('comenzar') || text.includes('start')) {
                        if (btn.disabled || btn.classList.contains('disabled')) return { found: true, canClick: false };
                        btn.click();
                        return { found: true, canClick: true };
                    }
                }
                return { found: false };
            });

            if (result.canClick) {
                logger.success('⚔️ ¡Héroe enviado!');
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

    async upgradeBuild() {
        if (this.page.isClosed()) return { success: false, reason: 'browser_closed' };
        
        logger.info('Buscando botón de mejora...');
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