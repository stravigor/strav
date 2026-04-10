# @strav/spring

Flagship framework scaffolding tool for the Strav ecosystem - the Laravel of the Bun ecosystem.

## Usage

```bash
bunx @strav/spring my-app --web   # full-stack with Vue islands
bunx @strav/spring my-app --api   # headless REST API
bunx @strav/spring my-app         # interactive prompt
```

## Templates

- **api** — Headless REST API with CORS enabled
- **web** — Full-stack with .strav views, Vue islands, and sessions

## Options

```
bunx @strav/spring <project-name> [options]

--api                     Headless REST API template
--web                     Full-stack template with Vue islands
--template, -t api|web    Alias for --api / --web
--db <name>               Database name (default: project name)
-h, --help                Show help
```

## What's scaffolded

```
my-app/
├── app/
│   ├── controllers/      # HTTP controllers
│   ├── models/           # Database models (generated from schemas)
│   ├── middleware/       # Custom middleware
│   ├── providers/        # Service providers
│   ├── policies/         # Authorization policies
│   ├── jobs/             # Queue jobs
│   └── services/         # Business logic services
├── config/               # Configuration files
├── database/
│   ├── schemas/public/   # Schema definitions
│   ├── migrations/public/ # Generated migrations
│   ├── seeders/          # Database seeders
│   └── factories/        # Model factories
├── resources/
│   ├── views/            # .strav templates
│   ├── css/              # Stylesheets
│   └── ts/islands/       # Vue.js islands
├── routes/               # Route definitions
├── tests/                # Test files
├── index.ts              # Application entry point
├── strav.ts              # CLI tool
└── .env                  # Environment variables
```

## License

MIT