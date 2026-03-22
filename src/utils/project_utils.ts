// src/utils/project_utils.ts
import * as path from 'path';

// ─── Типи ─────────────────────────────────────────────────────────────────

export type TechStack =
    // Frontend
    | 'html' | 'react' | 'vue' | 'angular' | 'svelte' | 'astro'
    // Fullstack
    | 'nextjs' | 'nuxt' | 'remix' | 'sveltekit'
    // Backend Node
    | 'node' | 'nestjs' | 'fastify' | 'hono'
    // Backend Python
    | 'flask' | 'fastapi' | 'django' | 'python'
    // Backend Other
    | 'golang' | 'spring' | 'rust' | 'dotnet' | 'php'
    // TypeScript
    | 'typescript' | 'deno'
    // Mobile
    | 'reactnative' | 'flutter'
    // Desktop
    | 'electron' | 'tauri'
    // Data/AI
    | 'datasci' | 'mlops'
    // Infrastructure
    | 'docker' | 'monorepo';

export interface ProjectLayout {
    stack:       TechStack;
    slug:        string;
    projectPath: string;
    dirs:        string[];
    entryFile:   string;
    initCmd:     string | null;
    promptHint:  string;
}

// ─── Детектор стеку (пріоритет зверху вниз) ───────────────────────────────

const STACK_KEYWORDS: Array<[TechStack, string[]]> = [
    // Infrastructure — найспецифічніші
    ['monorepo',    ['monorepo','mono repo','turborepo','nx workspace','pnpm workspace']],
    ['docker',      ['docker','докер','kubernetes','k8s','ci/cd','compose','devops']],
    // Mobile
    ['flutter',     ['flutter','dart','флаттер']],
    ['reactnative', ['react native','reactnative','expo ','мобільн','mobile app','ios app','android app']],
    // Desktop
    ['tauri',       ['tauri']],
    ['electron',    ['electron','desktop app','десктоп','настільн','windows app']],
    // Data/AI
    ['mlops',       ['machine learning','ml model','нейрон','neural','tensorflow','pytorch','deep learning']],
    ['datasci',     ['data science','jupyter','notebook','датасаєнс','аналіз даних','pandas','numpy']],
    // Fullstack
    ['sveltekit',   ['sveltekit','svelte kit']],
    ['remix',       ['remix','remixjs']],
    ['nuxt',        ['nuxt','nuxt3','nuxt.js']],
    ['nextjs',      ['next.js','nextjs','next js','app router','ssr react']],
    // Backend Other
    ['dotnet',      ['.net','dotnet','c#','csharp','asp.net','blazor']],
    ['spring',      ['spring boot','spring mvc','spring cloud','java spring','java api']],
    ['rust',        ['rust lang','axum','actix','раст api']],
    ['golang',      ['golang','go lang','gin go','fiber go','\bgo\b api']],
    ['php',         ['laravel','symfony','php','пхп']],
    // Backend Node
    ['nestjs',      ['nestjs','nest.js','нест js','@nestjs']],
    ['fastify',     ['fastify']],
    ['hono',        ['hono','bun server','edge api']],
    ['node',        ['express','node api','nodejs','node.js','rest api','бекенд js','backend node']],
    // Frontend
    ['angular',     ['angular','ng ','ангуляр','@angular']],
    ['svelte',      ['svelte','sveltekit']],
    ['astro',       ['astro','astrojs','static site generator']],
    ['vue',         ['vue','vuejs','vue.js']],
    ['react',       ['react','jsx','tsx react','реакт','create react']],
    // Python Backend
    ['django',      ['django','джанго']],
    ['fastapi',     ['fastapi','fast api']],
    ['flask',       ['flask','фласк']],
    ['python',      ['python','пайтон','py script','.py ','pip install']],
    // TypeScript
    ['deno',        ['deno','деноу']],
    ['typescript',  ['typescript','ts-node','типізован ts']],
    // Default
    ['html',        ['html','css','лендинг','landing','сайт','site','сторінк','page','верстк','vanilla js']],
];

export function detectStack(idea: string): TechStack {
    const lower = idea.toLowerCase();
    for (const [stack, keywords] of STACK_KEYWORDS) {
        if (keywords.some(kw => lower.includes(kw))) return stack;
    }
    return 'html';
}

// ─── Структури ────────────────────────────────────────────────────────────

interface StackDef {
    dirs:        string[];
    files:       string[];
    configFiles: string[];
    entry:       string;
    launch:      string;
    init:        string | null;
}

const DEFS: Record<TechStack, StackDef> = {
    // ── Frontend ──────────────────────────────────────────────────────────
    html: {
        dirs:        ['css','js','assets/images','assets/fonts'],
        files:       ['index.html','css/style.css','css/reset.css','js/main.js'],
        configFiles: ['README.md'],
        entry: 'index.html', launch: 'index.html', init: null,
    },
    react: {
        dirs:        ['src','src/components','src/pages','src/hooks',
                      'src/assets','src/styles','public'],
        files:       ['index.html','src/main.jsx','src/App.jsx',
                      'src/App.css','src/styles/index.css'],
        configFiles: ['package.json','vite.config.js','.eslintrc.json','.gitignore'],
        entry: 'src/App.jsx', launch: 'index.html', init: 'npm install',
    },
    vue: {
        dirs:        ['src','src/components','src/views','src/composables',
                      'src/stores','src/assets','public'],
        files:       ['index.html','src/main.js','src/App.vue','src/style.css'],
        configFiles: ['package.json','vite.config.js','.gitignore'],
        entry: 'src/App.vue', launch: 'index.html', init: 'npm install',
    },
    angular: {
        dirs:        ['src','src/app','src/app/components','src/app/services',
                      'src/app/models','src/app/guards','src/app/interceptors',
                      'src/app/pipes','src/assets','src/environments'],
        files:       ['src/main.ts','src/index.html','src/styles.css',
                      'src/app/app.component.ts','src/app/app.component.html',
                      'src/app/app.component.css','src/app/app.module.ts',
                      'src/app/app-routing.module.ts',
                      'src/environments/environment.ts',
                      'src/environments/environment.prod.ts'],
        configFiles: ['package.json','angular.json','tsconfig.json',
                      'tsconfig.app.json','.eslintrc.json','.gitignore'],
        entry: 'src/app/app.component.ts',
        launch: 'src/index.html', init: 'npm install',
    },
    svelte: {
        dirs:        ['src','src/lib','src/routes','static'],
        files:       ['src/app.html','src/routes/+page.svelte',
                      'src/lib/index.js'],
        configFiles: ['package.json','svelte.config.js','vite.config.js','.gitignore'],
        entry: 'src/routes/+page.svelte',
        launch: 'src/app.html', init: 'npm install',
    },
    astro: {
        dirs:        ['src','src/components','src/layouts','src/pages',
                      'src/styles','public'],
        files:       ['src/pages/index.astro','src/layouts/Layout.astro',
                      'src/styles/global.css'],
        configFiles: ['package.json','astro.config.mjs','tsconfig.json','.gitignore'],
        entry: 'src/pages/index.astro',
        launch: 'src/pages/index.astro', init: 'npm install',
    },
    // ── Fullstack ─────────────────────────────────────────────────────────
    nextjs: {
        dirs:        ['app','app/components','app/lib','app/api',
                      'public','styles'],
        files:       ['app/page.tsx','app/layout.tsx','app/globals.css',
                      'app/error.tsx','app/loading.tsx'],
        configFiles: ['package.json','next.config.js','tsconfig.json',
                      '.env.local','.gitignore'],
        entry: 'app/page.tsx', launch: 'app/page.tsx', init: 'npm install',
    },
    nuxt: {
        dirs:        ['pages','components','composables','server',
                      'server/api','assets','public','middleware'],
        files:       ['pages/index.vue','app.vue','server/api/hello.ts'],
        configFiles: ['package.json','nuxt.config.ts','tsconfig.json','.gitignore'],
        entry: 'pages/index.vue', launch: 'pages/index.vue', init: 'npm install',
    },
    remix: {
        dirs:        ['app','app/routes','app/components','app/utils','public'],
        files:       ['app/root.tsx','app/routes/_index.tsx',
                      'app/entry.client.tsx','app/entry.server.tsx'],
        configFiles: ['package.json','remix.config.js','tsconfig.json','.gitignore'],
        entry: 'app/root.tsx', launch: 'app/root.tsx', init: 'npm install',
    },
    sveltekit: {
        dirs:        ['src','src/routes','src/lib','src/lib/components','static'],
        files:       ['src/app.html','src/routes/+page.svelte',
                      'src/routes/+layout.svelte','src/lib/index.ts'],
        configFiles: ['package.json','svelte.config.js',
                      'vite.config.ts','tsconfig.json','.gitignore'],
        entry: 'src/routes/+page.svelte',
        launch: 'src/app.html', init: 'npm install',
    },
    // ── Backend Node ──────────────────────────────────────────────────────
    node: {
        dirs:        ['src','src/routes','src/controllers','src/middleware',
                      'src/models','src/utils','src/config','tests'],
        files:       ['src/index.js','src/app.js',
                      'src/config/database.js','.env.example'],
        configFiles: ['package.json','.eslintrc.json','.gitignore'],
        entry: 'src/index.js', launch: 'src/index.js', init: 'npm install',
    },
    nestjs: {
        dirs:        ['src','src/modules','src/common',
                      'src/common/filters','src/common/guards',
                      'src/common/interceptors','src/common/pipes',
                      'src/common/decorators','test'],
        files:       ['src/main.ts','src/app.module.ts',
                      'src/app.controller.ts','src/app.service.ts',
                      'src/app.controller.spec.ts'],
        configFiles: ['package.json','tsconfig.json','tsconfig.build.json',
                      'nest-cli.json','.eslintrc.js','.gitignore'],
        entry: 'src/main.ts', launch: 'src/main.ts', init: 'npm install',
    },
    fastify: {
        dirs:        ['src','src/routes','src/plugins',
                      'src/schemas','src/hooks','tests'],
        files:       ['src/app.js','src/server.js'],
        configFiles: ['package.json','.gitignore'],
        entry: 'src/server.js', launch: 'src/server.js', init: 'npm install',
    },
    hono: {
        dirs:        ['src','src/routes','src/middleware'],
        files:       ['src/index.ts'],
        configFiles: ['package.json','tsconfig.json','.gitignore'],
        entry: 'src/index.ts', launch: 'src/index.ts', init: 'npm install',
    },
    // ── Backend Python ────────────────────────────────────────────────────
    flask: {
        dirs:        ['app','app/routes','app/models','app/utils',
                      'tests','static','templates'],
        files:       ['app/__init__.py','app/routes/__init__.py',
                      'app/models/__init__.py','run.py','.env.example'],
        configFiles: ['requirements.txt','pyproject.toml','.gitignore'],
        entry: 'run.py', launch: 'run.py',
        init: 'pip install -r requirements.txt',
    },
    fastapi: {
        dirs:        ['app','app/routers','app/models','app/schemas',
                      'app/crud','app/core','tests'],
        files:       ['app/main.py','app/core/config.py',
                      'app/routers/__init__.py',
                      'app/models/__init__.py','.env.example'],
        configFiles: ['requirements.txt','pyproject.toml','.gitignore'],
        entry: 'app/main.py', launch: 'app/main.py',
        init: 'pip install -r requirements.txt',
    },
    django: {
        dirs:        ['config','config/settings','apps','apps/core',
                      'static','templates','media','tests'],
        files:       ['manage.py','config/urls.py','config/wsgi.py',
                      'config/asgi.py','config/settings/base.py',
                      'config/settings/dev.py','config/settings/prod.py',
                      'apps/core/models.py','apps/core/views.py',
                      'apps/core/urls.py','apps/core/admin.py',
                      'apps/core/serializers.py'],
        configFiles: ['requirements.txt','.env.example','.gitignore'],
        entry: 'manage.py', launch: 'manage.py',
        init: 'pip install -r requirements.txt',
    },
    python: {
        dirs:        ['src','tests','docs'],
        files:       ['src/main.py','src/__init__.py'],
        configFiles: ['requirements.txt','pyproject.toml',
                      'setup.py','.gitignore'],
        entry: 'src/main.py', launch: 'src/main.py',
        init: 'pip install -r requirements.txt',
    },
    // ── Backend Other ─────────────────────────────────────────────────────
    golang: {
        dirs:        ['cmd','cmd/server','internal','internal/handlers',
                      'internal/models','internal/middleware',
                      'internal/config','pkg','tests'],
        files:       ['cmd/server/main.go',
                      'internal/handlers/handler.go',
                      'internal/models/model.go',
                      'internal/config/config.go'],
        configFiles: ['go.mod','go.sum','.gitignore'],
        entry: 'cmd/server/main.go',
        launch: 'cmd/server/main.go', init: 'go mod tidy',
    },
    spring: {
        dirs:        ['src/main/java/com/app/controller',
                      'src/main/java/com/app/service',
                      'src/main/java/com/app/model',
                      'src/main/java/com/app/repository',
                      'src/main/java/com/app/config',
                      'src/main/java/com/app/exception',
                      'src/main/resources',
                      'src/test/java/com/app'],
        files:       ['src/main/java/com/app/Application.java',
                      'src/main/resources/application.yml',
                      'src/main/resources/application-dev.yml',
                      'src/main/resources/application-prod.yml'],
        configFiles: ['pom.xml','.gitignore'],
        entry: 'src/main/java/com/app/Application.java',
        launch: 'src/main/java/com/app/Application.java',
        init: 'mvn install',
    },
    rust: {
        dirs:        ['src','tests','benches'],
        files:       ['src/main.rs','src/lib.rs',
                      'tests/integration_test.rs'],
        configFiles: ['Cargo.toml','Cargo.lock','.gitignore'],
        entry: 'src/main.rs', launch: 'src/main.rs', init: 'cargo build',
    },
    dotnet: {
        dirs:        ['src','src/Controllers','src/Models',
                      'src/Services','src/Data','src/Middleware','tests'],
        files:       ['src/Program.cs',
                      'src/appsettings.json',
                      'src/appsettings.Development.json'],
        configFiles: ['*.csproj','*.sln','.gitignore'],
        entry: 'src/Program.cs', launch: 'src/Program.cs',
        init: 'dotnet restore',
    },
    php: {
        dirs:        ['app','app/Http/Controllers','app/Http/Middleware',
                      'app/Models','app/Services','app/Providers',
                      'database/migrations','database/seeders',
                      'resources/views','routes','tests/Feature',
                      'tests/Unit','public','config','storage/logs'],
        files:       ['routes/web.php','routes/api.php',
                      'app/Http/Controllers/Controller.php',
                      'public/index.php'],
        configFiles: ['composer.json','.env.example','.gitignore'],
        entry: 'public/index.php', launch: 'public/index.php',
        init: 'composer install',
    },
    // ── TypeScript ────────────────────────────────────────────────────────
    typescript: {
        dirs:        ['src','src/types','src/utils',
                      'src/services','src/config','tests','dist'],
        files:       ['src/index.ts','src/types/index.ts',
                      'src/config/index.ts'],
        configFiles: ['package.json','tsconfig.json',
                      '.eslintrc.json','.gitignore'],
        entry: 'src/index.ts', launch: 'src/index.ts', init: 'npm install',
    },
    deno: {
        dirs:        ['src','src/routes','src/middleware','static'],
        files:       ['src/main.ts','src/routes/index.ts'],
        configFiles: ['deno.json','deno.lock','.gitignore'],
        entry: 'src/main.ts', launch: 'src/main.ts', init: null,
    },
    // ── Mobile ────────────────────────────────────────────────────────────
    reactnative: {
        dirs:        ['src','src/screens','src/components','src/navigation',
                      'src/hooks','src/store','src/api','src/utils','assets'],
        files:       ['App.tsx','src/screens/HomeScreen.tsx',
                      'src/navigation/AppNavigator.tsx',
                      'src/components/index.ts'],
        configFiles: ['package.json','app.json','tsconfig.json',
                      'babel.config.js','.gitignore'],
        entry: 'App.tsx', launch: 'App.tsx', init: 'npm install',
    },
    flutter: {
        dirs:        ['lib','lib/screens','lib/widgets','lib/models',
                      'lib/services','lib/utils','lib/constants',
                      'assets','test'],
        files:       ['lib/main.dart','lib/app.dart',
                      'lib/screens/home_screen.dart',
                      'lib/widgets/app_bar.dart'],
        configFiles: ['pubspec.yaml','.gitignore'],
        entry: 'lib/main.dart', launch: 'lib/main.dart',
        init: 'flutter pub get',
    },
    // ── Desktop ───────────────────────────────────────────────────────────
    electron: {
        dirs:        ['src','src/main','src/renderer',
                      'src/renderer/components','src/preload','assets'],
        files:       ['src/main/index.js','src/preload/preload.js',
                      'src/renderer/index.html','src/renderer/app.js',
                      'src/renderer/style.css'],
        configFiles: ['package.json','.gitignore'],
        entry: 'src/main/index.js', launch: 'src/main/index.js',
        init: 'npm install',
    },
    tauri: {
        dirs:        ['src','src-tauri','src-tauri/src',
                      'src-tauri/icons'],
        files:       ['src/main.ts','src/App.vue',
                      'src-tauri/src/main.rs','src-tauri/src/lib.rs'],
        configFiles: ['package.json','src-tauri/Cargo.toml',
                      'src-tauri/tauri.conf.json','tsconfig.json','.gitignore'],
        entry: 'src-tauri/src/main.rs', launch: 'src/main.ts',
        init: 'npm install',
    },
    // ── Data/AI ───────────────────────────────────────────────────────────
    datasci: {
        dirs:        ['notebooks','src','src/data','src/features',
                      'src/models','src/visualization',
                      'data/raw','data/processed','reports'],
        files:       ['notebooks/01_exploration.ipynb',
                      'src/data/load_data.py',
                      'src/models/train.py'],
        configFiles: ['requirements.txt','setup.py','README.md','.gitignore'],
        entry: 'src/models/train.py', launch: 'src/models/train.py',
        init: 'pip install -r requirements.txt',
    },
    mlops: {
        dirs:        ['src','src/data','src/features','src/models',
                      'src/pipelines','src/api','tests',
                      'configs','artifacts'],
        files:       ['src/main.py','src/models/model.py',
                      'src/pipelines/train.py','configs/config.yaml'],
        configFiles: ['requirements.txt','Makefile','.gitignore'],
        entry: 'src/main.py', launch: 'src/main.py',
        init: 'pip install -r requirements.txt',
    },
    // ── Infrastructure ────────────────────────────────────────────────────
    docker: {
        dirs:        ['services','nginx','scripts','configs','monitoring'],
        files:       ['docker-compose.yml','docker-compose.dev.yml',
                      'nginx/nginx.conf','scripts/deploy.sh'],
        configFiles: ['.env.example','.gitignore','Makefile'],
        entry: 'docker-compose.yml', launch: 'docker-compose.yml',
        init: 'docker-compose up --build',
    },
    monorepo: {
        dirs:        ['apps','apps/web','apps/api',
                      'packages','packages/ui',
                      'packages/utils','packages/config'],
        files:       ['apps/web/package.json','apps/api/package.json',
                      'packages/ui/index.ts'],
        configFiles: ['package.json','turbo.json',
                      'pnpm-workspace.yaml','.gitignore'],
        entry: 'apps/web/package.json',
        launch: 'apps/web/package.json', init: 'pnpm install',
    },
};

// ─── Slug ─────────────────────────────────────────────────────────────────

const TRANSLIT: Record<string, string> = {
    'а':'a','б':'b','в':'v','г':'h','д':'d','е':'e','є':'ye','ж':'zh',
    'з':'z','и':'y','і':'i','ї':'yi','й':'y','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ь':'','ю':'yu',
    'я':'ya','ґ':'g',
};
const NOISE = new Set([
    'створи','зроби','напиши','make','create','build','write','generate',
    'додай','add','implement','для','for','the','a','an','та','and',
    'з','with','в','in','на','at','новий','new','простий','simple',
]);

function toSlug(text: string): string {
    return text.toLowerCase()
        .split('').map(c => TRANSLIT[c] ?? c).join('')
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !NOISE.has(w))
        .slice(0, 3).join('-')
        .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const STACK_SUFFIX: Record<TechStack, string> = {
    html:'', react:'-react', vue:'-vue', angular:'-ng', svelte:'-svelte',
    astro:'-astro', nextjs:'-next', nuxt:'-nuxt', remix:'-remix',
    sveltekit:'-sk', node:'-api', nestjs:'-nest', fastify:'-fastify',
    hono:'-hono', flask:'-flask', fastapi:'-fastapi', django:'-django',
    python:'-py', golang:'-go', spring:'-spring', rust:'-rust',
    dotnet:'-dotnet', php:'-laravel', typescript:'-ts', deno:'-deno',
    reactnative:'-rn', flutter:'-flutter', electron:'-desktop',
    tauri:'-tauri', datasci:'-ds', mlops:'-ml',
    docker:'-docker', monorepo:'-mono',
};

export function extractProjectSlug(idea: string, stack: TechStack): string {
    const lower = idea.toLowerCase();
    const namedMatch = lower.match(
        /(?:для|for|named?|під назвою|called|проєкт|project)\s+["']?([a-zа-яіїєґ0-9 -]{2,25})["']?/i
    );
    const base = namedMatch ? toSlug(namedMatch[1].trim()) : toSlug(idea);
    const slug = base
        ? `${base}${STACK_SUFFIX[stack]}`
        : `${stack}-${Date.now().toString(36)}`;
    return slug.substring(0, 45);
}

// ─── Головна функція ──────────────────────────────────────────────────────

export function buildProjectLayout(
    idea: string,
    workspaceRoot: string
): ProjectLayout {
    const stack = detectStack(idea);
    const slug  = extractProjectSlug(idea, stack);
    const def   = DEFS[stack];
    const projectPath = path.join(workspaceRoot, slug);

    const exampleFiles = [...def.files, ...def.configFiles]
        .slice(0, 5)
        .map(f => `  write_file → {"filename": "${slug}/${f}", "content": "..."}`)
        .join('\n');

    const promptHint = [
        `═══ PROJECT STRUCTURE ═══`,
        `Stack:          ${stack}`,
        `Project folder: workspace/${slug}/`,
        `Entry file:     ${slug}/${def.entry}`,
        ``,
        `ALL files MUST use the "${slug}/" prefix:`,
        exampleFiles,
        ``,
        `Available subdirs: ${def.dirs.slice(0,6).map(d => slug+'/'+d).join(', ')}`,
        def.init
            ? `After writing files run: execute_bash → {"command": "${def.init}"}`
            : `No package manager needed.`,
        `Launch: launch_file → {"filename": "${slug}/${def.launch}"}`,
        `═════════════════════════`,
    ].join('\n');

    return {
        stack,
        slug,
        projectPath,
        dirs:      def.dirs.map(d => path.join(projectPath, d)),
        entryFile: `${slug}/${def.launch}`,
        initCmd:   def.init,
        promptHint,
    };
}
