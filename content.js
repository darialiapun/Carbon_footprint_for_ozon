console.log("%c ECO-WIDGET: Скрипт успешно загружен! ", "background: #222; color: #bada55; font-size: 20px;");

(function () {
    "use strict";

    const CLIMATIQ_API_KEY = typeof CONFIG !== 'undefined' ? CONFIG.CLIMATIQ_API_KEY : "";
    const CLIMATIQ_URL = "https://api.climatiq.io/estimate/v1/general/custom";

    const MONTH_LIMIT_CO2 = 166;
    const LDPE_DENSITY = 920;
    const LDPE_THICKNESS_M = 0.00006;
    const LDPE_EMISSION_FACTOR = 2.11;

    const FALLBACK_FACTORS = {
        clothes: 7.5,      // кг CO2e / кг
        electronics: 80,   // кг CO2e / ед
        plastic: 6         // кг CO2e / кг
    };

    const HEROES = [
        { name: "Пингвин", emoji: "🐧", lifetimeKg: 62 },
        { name: "Ленивец", emoji: "🦥", lifetimeKg: 71 },
        { name: "Панда", emoji: "🐼", lifetimeKg: 95 },
        { name: "Лисица", emoji: "🦊", lifetimeKg: 58 },
        { name: "Коала", emoji: "🐨", lifetimeKg: 67 }
    ];

    const SELECTORS = {
        rightColumn: [
            '[data-widget="webPrice"]',
            '[data-widget="addToCartButton"]',
            '[data-widget="webStickyProducts"]',
            'aside',
            '.p8e'
        ],
        title: "h1",
        breadcrumbs: '[data-widget="breadCrumbs"] a, nav[aria-label*="хлеб"] a'
    };

    let scheduledRun = null;
    let currentProductKey = "";
    let observer = null;
    let isRendering = false;

    function parseNumber(raw) {
        if (!raw) return null;
        const normalized = String(raw).replace(/\s+/g, "").replace(",", ".");
        const value = Number.parseFloat(normalized);
        return Number.isFinite(value) ? value : null;
    }

    function parseWeightToKg(weightText) {
        if (!weightText) return null;
        const match = weightText.match(/(\d+(?:[.,]\d+)?)(?:\s*)(кг|г|kg|g)?/i);
        if (!match) return null;
        const value = parseNumber(match[1]);
        if (value === null) return null;
        const unit = (match[2] || "г").toLowerCase();
        return unit.includes("кг") || unit === "kg" ? value : value / 1000;
    }

    function parseDimensionsMm(dimText) {
        if (!dimText) return null;
        const nums = dimText
            .replace(/,/g, ".")
            .match(/\d+(?:\.\d+)?/g);
        if (!nums || nums.length < 3) return null;

        const [lengthMm, widthMm, heightMm] = nums.slice(0, 3).map(Number);
        if (![lengthMm, widthMm, heightMm].every((n) => Number.isFinite(n))) return null;

        return { lengthMm, widthMm, heightMm };
    }

    function collectLabelValuePairs() {
        const pairs = {};
        const nodes = document.querySelectorAll("dt, dd, th, td, div, span, li");

        for (const node of nodes) {
            const text = node.textContent?.trim();
            if (!text || text.length > 80) continue;

            if (/^Вес товара,?\s*г$/i.test(text) || /^Размеры,?\s*мм$/i.test(text)) {
                let valueText = "";
                const next = node.nextElementSibling;
                if (next?.textContent) valueText = next.textContent.trim();
                if (!valueText) {
                    const parentText = node.parentElement?.textContent?.trim() || "";
                    valueText = parentText.replace(text, "").trim();
                }
                if (valueText) pairs[text.toLowerCase()] = valueText;
            }
        }
        return pairs;
    }

    function extractProductData() {
        const pairs = collectLabelValuePairs();
        const fullText = document.body.innerText || "";

        const weightFromPairs =
            pairs["вес товара, г"] ||
            pairs["вес товара г"] ||
            fullText.match(/Вес товара,?\s*г[\s:]*([^\n]+)/i)?.[1];

        const dimensionsFromPairs =
            pairs["размеры, мм"] ||
            pairs["размеры мм"] ||
            fullText.match(/Размеры,?\s*мм[\s:]*([^\n]+)/i)?.[1];

        const weightKg = parseWeightToKg(weightFromPairs);
        const dimensions = parseDimensionsMm(dimensionsFromPairs);

        const productName = document.querySelector(SELECTORS.title)?.textContent?.trim() || "Товар";
        const category = Array.from(document.querySelectorAll(SELECTORS.breadcrumbs))
            .map((el) => el.textContent?.trim())
            .filter(Boolean)
            .join(" / ");

        return {
            productName,
            category,
            weightKg,
            dimensions
        };
    }

    async function waitForProductData(maxAttempts = 20, delayMs = 350) {
        for (let i = 0; i < maxAttempts; i += 1) {
            const data = extractProductData();
            if (data.weightKg && data.dimensions) return data;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        return extractProductData();
    }

    function classifyProduct(productName, category) {
        const text = `${productName} ${category}`.toLowerCase();
        if (/(плать|футбол|куртк|брюк|одежд|clothes|fashion)/i.test(text)) return "clothes";
        if (/(телефон|смартфон|ноутбук|планшет|наушник|камера|электрон|electronics)/i.test(text)) return "electronics";
        if (/(пластик|plastic|полимер)/i.test(text)) return "plastic";
        return "clothes";
    }

    async function fetchProductFootprint(data) {
        if (!CLIMATIQ_API_KEY || CLIMATIQ_API_KEY.includes("ВСТАВЬ")) return null;
        try {
            const response = await fetch(CLIMATIQ_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${CLIMATIQ_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    item: data.category || data.productName,
                    amount: data.weightKg || 1,
                    unit: "kg"
                })
            });

            if (!response.ok) return null;
            const result = await response.json();
            return Number.isFinite(result?.co2e) ? result.co2e : null;
        } catch (error) {
            return null;
        }
    }

    function fallbackProductFootprint(data) {
        const type = classifyProduct(data.productName, data.category);
        if (type === "electronics") return FALLBACK_FACTORS.electronics;
        const weight = data.weightKg || 1;
        if (type === "plastic") return weight * FALLBACK_FACTORS.plastic;
        return weight * FALLBACK_FACTORS.clothes;
    }

    function calcPackagingWeightKg(dimensions) {
        if (!dimensions) return 0;
        const a = dimensions.lengthMm / 1000;
        const b = dimensions.widthMm / 1000;
        const c = dimensions.heightMm / 1000;
        const surfaceArea = 2 * ((a * b) + (b * c) + (a * c));
        return surfaceArea * LDPE_THICKNESS_M * LDPE_DENSITY;
    }

    function calcPackagingEmissionKg(dimensions) {
        const packagingWeightKg = calcPackagingWeightKg(dimensions);
        return packagingWeightKg * LDPE_EMISSION_FACTOR;
    }

    function calcProgressColor(percentage) {
        const clamped = Math.max(0, Math.min(1, percentage));
        const hue = 120 - (120 * clamped);
        return `hsl(${hue}, 90%, 48%)`;
    }

    function pickHero() {
        const index = Math.floor(Math.random() * HEROES.length);
        return HEROES[index];
    }

    function findInjectionTarget() {
        for (const selector of SELECTORS.rightColumn) {
            const target = document.querySelector(selector);
            if (target) return target;
        }
        return null;
    }

    function upsertWidget(target) {
        let widget = document.getElementById("eco-widget");
        if (!widget) {
            widget = document.createElement("section");
            widget.id = "eco-widget";
            widget.className = "eco-widget-card";
            target.insertAdjacentElement("afterend", widget);
        } else if (!widget.isConnected && target.parentElement) {
            target.insertAdjacentElement("afterend", widget);
        }
        return widget;
    }

    function renderWidget(target, payload) {
        const widget = upsertWidget(target);
        const progressValue = Math.min((payload.totalFootprint / MONTH_LIMIT_CO2) * 100, 100);
        const progressColor = calcProgressColor(progressValue / 100);
        const heroPercent = Math.min((payload.totalFootprint / payload.hero.lifetimeKg) * 100, 100);

        const radius = 32;
        const circumference = 2 * Math.PI * radius;
        const dashOffset = circumference * (1 - progressValue / 100);

        widget.innerHTML = `
            <div class="eco-header">Общий след (товар + упаковка + логистика)</div>
            <div class="eco-stats-row">
                <div class="eco-circle-container" aria-label="Месячный лимит CO2">
                    <svg class="eco-circle-svg" width="80" height="80" viewBox="0 0 80 80">
                        <circle class="eco-circle-bg" cx="40" cy="40" r="${radius}"></circle>
                        <circle
                            class="eco-circle-progress"
                            cx="40"
                            cy="40"
                            r="${radius}"
                            stroke="${progressColor}"
                            stroke-dasharray="${circumference}"
                            stroke-dashoffset="${dashOffset}">
                        </circle>
                    </svg>
                    <div class="eco-circle-label">${progressValue.toFixed(1)}%</div>
                </div>
                <div class="eco-main-value">
                    <div class="eco-month-label">АПРЕЛЬ</div>
                    <div class="eco-co2-number">${payload.totalFootprint.toFixed(2)} кг CO2</div>
                    <div class="eco-co2-label">из лимита ${MONTH_LIMIT_CO2} кг CO2</div>
                </div>
            </div>
            <div class="eco-slider-wrap">
                <div class="eco-slider-track">
                    <div class="eco-slider-thumb" style="left: calc(${progressValue}% - 10px);"></div>
                </div>
            </div>
            <div class="eco-hero-box">
                <div class="eco-hero-emoji">${payload.hero.emoji}</div>
                <div class="eco-hero-text">
                    <strong>${heroPercent.toFixed(0)}% от жизненного следа ${payload.hero.name}</strong>
                    <span>Товар: ${payload.productEmission.toFixed(2)} кг · Упаковка: ${payload.packagingEmission.toFixed(3)} кг</span>
                </div>
            </div>
        `;
    }

    /*async function runWidgetPipeline() {
        if (isRendering) return;
        isRendering = true;

        try {
            if (!/\/(product|context\/detail\/id)\//.test(location.pathname)) {
                document.getElementById("eco-widget")?.remove();
                return;
            }

            const target = findInjectionTarget();
            if (!target) return;

            const data = await waitForProductData();
            if (!data.weightKg || !data.dimensions) return;

            const productKey = `${location.pathname}|${data.productName}|${data.weightKg}|${data.dimensions.lengthMm}x${data.dimensions.widthMm}x${data.dimensions.heightMm}`;
            if (productKey === currentProductKey && document.getElementById("eco-widget")) return;
            currentProductKey = productKey;

            const productEmissionFromApi = await fetchProductFootprint(data);
            const productEmission = productEmissionFromApi ?? fallbackProductFootprint(data);
            const packagingEmission = calcPackagingEmissionKg(data.dimensions);
            const logisticsEmission = productEmission * 0.08;
            const totalFootprint = productEmission + packagingEmission + logisticsEmission;

            renderWidget(target, {
                totalFootprint,
                productEmission,
                packagingEmission,
                hero: pickHero()
            });
        } finally {
            isRendering = false;
        }
    }*/
    async function runWidgetPipeline() {
        console.log("Eco-Extension: Проверка страницы..."); 
        if (isRendering) return;
        isRendering = true;
    
        try {
            // Упрощенная проверка: ищем '/product/' или просто наличие ID в ссылке
            const isProductPage = location.pathname.includes("/product/") || /\/\d+\/?$/.test(location.pathname);
            
            if (!isProductPage) {
                console.log("Eco-Extension: Это не страница товара");
                document.getElementById("eco-widget")?.remove();
                return;
            }
    
            const target = findInjectionTarget();
            if (!target) {
                console.warn("Eco-Extension: Не найдена колонка для вставки виджета");
                return;
            }
    
            console.log("Eco-Extension: Собираем данные...");
            const data = await waitForProductData();
            console.log("Eco-Extension: Данные получены:", data);
    
            // ВРЕМЕННО убери 'return', чтобы виджет появился даже если вес не нашелся
            const productEmissionFromApi = await fetchProductFootprint(data);
            const productEmission = productEmissionFromApi ?? fallbackProductFootprint(data);
            const packagingEmission = calcPackagingEmissionKg(data.dimensions) || 0.005; // дефолт 5г
            const logisticsEmission = productEmission * 0.08;
            const totalFootprint = productEmission + packagingEmission + logisticsEmission;
    
            renderWidget(target, {
                totalFootprint,
                productEmission,
                packagingEmission,
                hero: pickHero()
            });
            console.log("Eco-Extension: Виджет отрисован!");
    
        } catch (err) {
            console.error("Eco-Extension: Ошибка в пайплайне:", err);
        } finally {
            isRendering = false;
        }
    }
    function scheduleRun(delay = 250) {
        window.clearTimeout(scheduledRun);
        scheduledRun = window.setTimeout(() => {
            runWidgetPipeline().catch(() => {});
        }, delay);
    }

    function setupNavigationHooks() {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            const result = originalPushState.apply(this, args);
            scheduleRun(150);
            return result;
        };

        history.replaceState = function (...args) {
            const result = originalReplaceState.apply(this, args);
            scheduleRun(150);
            return result;
        };

        window.addEventListener("popstate", () => scheduleRun(150));
    }

    function setupObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver(() => scheduleRun(350));
        observer.observe(document.body, { childList: true, subtree: true });
    }

    setupNavigationHooks();
    setupObserver();
    scheduleRun(0);
})();