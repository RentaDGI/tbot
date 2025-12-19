/**
 * Debug: muestra todos los elementos relacionados con aldeas
 */

require('dotenv').config();
const GameClient = require('../classes/GameClient');

async function main() {
    const client = new GameClient();
    await client.init();

    try {
        await client.login();

        const debug = await client.page.evaluate(() => {
            const result = {
                allLinks: [],
                allLi: [],
                sidebarBox: null,
                villageDropdown: null
            };

            // Buscar todos los enlaces con newdid
            const links = Array.from(document.querySelectorAll('a[href*="newdid="]'));
            result.allLinks = links.map(a => ({
                href: a.getAttribute('href'),
                text: a.textContent?.trim(),
                classes: a.className,
                parent: a.parentElement?.tagName + '.' + a.parentElement?.className
            }));

            // Buscar todos los li con data-did
            const lis = Array.from(document.querySelectorAll('li[data-did]'));
            result.allLi = lis.map(li => ({
                dataDid: li.getAttribute('data-did'),
                text: li.textContent?.trim(),
                classes: li.className,
                parent: li.parentElement?.tagName + '.' + li.parentElement?.className
            }));

            // Verificar sidebar
            const sidebar = document.querySelector('#sidebarBoxVillagelist');
            if (sidebar) {
                result.sidebarBox = {
                    exists: true,
                    html: sidebar.innerHTML.substring(0, 500),
                    children: sidebar.children.length
                };
            }

            // Buscar dropdown de aldeas
            const dropdown = document.querySelector('.villageList, #villageList, [class*="village"]');
            if (dropdown) {
                result.villageDropdown = {
                    exists: true,
                    className: dropdown.className,
                    html: dropdown.innerHTML.substring(0, 500)
                };
            }

            return result;
        });

        console.log('\n==== DEBUG VILLAGES ====\n');
        console.log('Enlaces encontrados con newdid:');
        console.log(JSON.stringify(debug.allLinks, null, 2));

        console.log('\n\nLI encontrados con data-did:');
        console.log(JSON.stringify(debug.allLi, null, 2));

        console.log('\n\nSidebar box:');
        console.log(JSON.stringify(debug.sidebarBox, null, 2));

        console.log('\n\nVillage dropdown:');
        console.log(JSON.stringify(debug.villageDropdown, null, 2));

    } catch (error) {
        console.error('Error:', error.message);
        process.exitCode = 1;
    } finally {
        await client.close();
    }
}

if (require.main === module) {
    main();
}

module.exports = main;
