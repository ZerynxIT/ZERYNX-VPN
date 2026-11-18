/* =====================================
   ZERYNX VPN — APPLICATION CORE
   ===================================== */

document.addEventListener("DOMContentLoaded", () => {

    const html = document.documentElement;

    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebarOverlay");

    const menuToggle = document.getElementById("menuToggle");
    const sidebarClose = document.getElementById("sidebarClose");

    const themeToggle = document.getElementById("themeToggle");
    const languageToggle = document.getElementById("languageToggle");

    const pageTitle = document.getElementById("pageTitle");

    /* =====================================
       THEME MANAGEMENT
       ===================================== */

    const savedTheme = localStorage.getItem("zerynx-theme") || "dark";

    function setTheme(theme) {

        html.dataset.theme = theme;

        localStorage.setItem("zerynx-theme", theme);

        if (themeToggle) {
            themeToggle.textContent = theme === "dark" ? "☼" : "☾";
            themeToggle.setAttribute(
                "aria-label",
                theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
            );
        }
    }

    setTheme(savedTheme);

    themeToggle?.addEventListener("click", () => {

        const currentTheme = html.dataset.theme;

        setTheme(currentTheme === "dark" ? "light" : "dark");

    });


    /* =====================================
       LANGUAGE MANAGEMENT
       ===================================== */

    const savedLanguage = localStorage.getItem("zerynx-language") || "fa";

    function setLanguage(language) {

        const isEnglish = language === "en";

        html.lang = language;
        html.dir = isEnglish ? "ltr" : "rtl";

        document.querySelectorAll("[data-fa][data-en]").forEach(element => {

            element.textContent = isEnglish
                ? element.dataset.en
                : element.dataset.fa;

        });

        if (languageToggle) {
            languageToggle.textContent = isEnglish ? "FA" : "EN";
        }

        localStorage.setItem("zerynx-language", language);

        updatePageTitle();
    }

    languageToggle?.addEventListener("click", () => {

        const nextLanguage = html.lang === "fa" ? "en" : "fa";

        setLanguage(nextLanguage);

    });


    /* =====================================
       SIDEBAR
       ===================================== */

    function openSidebar() {

        sidebar?.classList.add("open");
        overlay?.classList.add("show");

    }

    function closeSidebar() {

        sidebar?.classList.remove("open");
        overlay?.classList.remove("show");

    }

    menuToggle?.addEventListener("click", openSidebar);

    sidebarClose?.addEventListener("click", closeSidebar);

    overlay?.addEventListener("click", closeSidebar);

    document.addEventListener("keydown", event => {

        if (event.key === "Escape") {
            closeSidebar();
        }

    });


    /* =====================================
       PAGE NAVIGATION
       ===================================== */

    const pageNames = {

        dashboard: {
            fa: "داشبورد",
            en: "Dashboard"
        },

        users: {
            fa: "کاربران",
            en: "Users"
        },

        inbounds: {
            fa: "این‌باندها",
            en: "Inbounds"
        },

        nodes: {
            fa: "نودها",
            en: "Nodes"
        },

        subscriptions: {
            fa: "اشتراک‌ها",
            en: "Subscriptions"
        },

        traffic: {
            fa: "مصرف ترافیک",
            en: "Traffic"
        },

        logs: {
            fa: "گزارش‌ها",
            en: "Activity Logs"
        },

        settings: {
            fa: "تنظیمات",
            en: "Settings"
        }

    };

    function updatePageTitle() {

        const currentPage = location.hash.replace("#", "") || "dashboard";

        const page = pageNames[currentPage];

        if (!page || !pageTitle) return;

        pageTitle.textContent = html.lang === "en"
            ? page.en
            : page.fa;

    }

    function navigateToPage(page) {

        if (!pageNames[page]) return;

        location.hash = page;

        document.querySelectorAll(".nav-item[data-page]").forEach(item => {

            item.classList.toggle(
                "active",
                item.dataset.page === page
            );

        });

        updatePageTitle();

        closeSidebar();

    }

    document.querySelectorAll("[data-page]").forEach(element => {

        element.addEventListener("click", event => {

            event.preventDefault();

            navigateToPage(element.dataset.page);

        });

    });

    window.addEventListener("hashchange", () => {

        const page = location.hash.replace("#", "") || "dashboard";

        document.querySelectorAll(".nav-item[data-page]").forEach(item => {

            item.classList.toggle(
                "active",
                item.dataset.page === page
            );

        });

        updatePageTitle();

    });


    /* =====================================
       INITIALIZATION
       ===================================== */

    setLanguage(savedLanguage);

    const initialPage = location.hash.replace("#", "") || "dashboard";

    navigateToPage(initialPage);

});
