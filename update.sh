#!/bin/bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${CYAN}========================================${NC}"
echo -e "${CYAN}  MTProto Service Node - Обновление     ${NC}"
echo -e "${CYAN}========================================${NC}"
echo ""

# Парсим аргументы
FORCE_BRANCH=""
FORCE_BUILD=0
FORCE_PULL=0
for arg in "$@"; do
    case "$arg" in
        --b=*) FORCE_BRANCH="${arg#--b=}" ;;
        --build) FORCE_BUILD=1 ;;
        --pull) FORCE_PULL=1 ;;
    esac
done

# Проверяем что мы в директории с docker-compose.yml
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}Ошибка: docker-compose.yml не найден.${NC}"
    echo -e "Запустите скрипт из директории сервис-ноды."
    exit 1
fi

# Проверяем что это git-репозиторий
if [ ! -d ".git" ]; then
    echo -e "${RED}Ошибка: это не git-репозиторий.${NC}"
    echo -e "Сервис-нода должна быть установлена через git clone."
    exit 1
fi

# Проверяем наличие .env
if [ ! -f ".env" ]; then
    echo -e "${RED}Ошибка: файл .env не найден.${NC}"
    echo -e "Убедитесь что сервис-нода была установлена через install.sh."
    exit 1
fi

# Запущенный внутри контейнера сервис-ноды, скрипт убивает сам себя: `docker compose
# down` удаляет тот самый контейнер, в котором он работает, процесс умирает вместе с
# ним, и поднимать ноду обратно уже некому. Так кнопка «Обновить» в панели гарантированно
# роняла ноду насмерть. Поэтому перезапускаем себя в контейнере-спутнике: он не входит в
# compose-проект, `down` его не трогает, и он спокойно доводит обновление до конца.
if [ -f /.dockerenv ] && [ "${MTPROTO_UPDATE_SIDECAR:-0}" != "1" ]; then
    SELF_NAME="mtproto-service-node"
    HOST_PROJECT=$(docker inspect "$SELF_NAME" --format '{{range .Mounts}}{{if eq .Destination "/app/project"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
    SELF_IMAGE=$(docker inspect "$SELF_NAME" --format '{{.Config.Image}}' 2>/dev/null || true)

    if [ -z "$HOST_PROJECT" ] || [ -z "$SELF_IMAGE" ]; then
        echo -e "${RED}Не удалось определить каталог проекта на хосте.${NC}"
        echo -e "Обновление отменено, чтобы не оставить ноду выключенной."
        exit 1
    fi

    mkdir -p data
    docker rm -f mtproto-node-updater >/dev/null 2>&1 || true
    docker run -d --name mtproto-node-updater \
        --network mtproto-net \
        -v /var/run/docker.sock:/var/run/docker.sock \
        -v "${HOST_PROJECT}":/app/project \
        -w /app/project \
        -e MTPROTO_UPDATE_SIDECAR=1 \
        "$SELF_IMAGE" \
        bash -c 'bash update.sh "$@" > /app/project/data/update.log 2>&1' _ "$@" >/dev/null

    echo -e "${GREEN}Обновление запущено в отдельном контейнере mtproto-node-updater.${NC}"
    echo -e "Нода перезапустится сама; журнал — data/update.log"
    exit 0
fi

# Порт API берём из .env: compose публикует именно его, а проверка готовности
# ниже раньше использовала дефолт 8443 и на ноде с другим PORT не проходила
# никогда — обновление завершалось ошибкой при полностью исправной ноде.
PORT=$(grep '^PORT=' .env | cut -d'=' -f2)
PORT=${PORT:-8443}

# В контейнере-спутнике localhost — он сам, а не хост, где опубликован порт ноды.
if [ "${MTPROTO_UPDATE_SIDECAR:-0}" = "1" ]; then
    API_URL="http://mtproto-service-node:8443"
else
    API_URL="http://localhost:${PORT}"
fi

echo -e "${CYAN}[1/5] Получение списка запущенных прокси...${NC}"

# Запоминаем ID запущенных прокси-контейнеров (mtproto-proxy-*)
RUNNING_PROXIES=$(docker ps --format '{{.Names}}' | grep '^mtproto-proxy-' || true)

if [ -n "$RUNNING_PROXIES" ]; then
    PROXY_COUNT=$(echo "$RUNNING_PROXIES" | wc -l)
    echo -e "  Найдено запущенных прокси: ${YELLOW}${PROXY_COUNT}${NC}"
else
    echo -e "  Запущенных прокси не найдено"
fi

echo -e "${CYAN}[2/5] Остановка сервис-ноды...${NC}"
docker compose down

echo -e "${CYAN}[3/5] Получение обновлений из репозитория...${NC}"

# Сохраняем локальные изменения если есть (data/, .env)
git stash --include-untracked 2>/dev/null || true

# Определяем ветку (из аргумента или автоматически)
DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-master}
if [ -n "$FORCE_BRANCH" ]; then
    BRANCH="$FORCE_BRANCH"
else
    BRANCH="$DEFAULT_BRANCH"
fi
echo -e "  Ветка: ${YELLOW}${BRANCH}${NC}"

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
git stash pop 2>/dev/null || true

echo -e "${CYAN}[4/5] Загрузка и запуск обновлённой сервис-ноды...${NC}"
export COMPOSE_PROJECT_NAME=mtproto-node
docker network create mtproto-net 2>/dev/null || true

# Готовые образы в GHCR собираются только с веток master и dev. Взять оттуда образ,
# обновившись с любой другой ветки, значит запустить чужой код поверх её исходников —
# молча и без единой ошибки. Поэтому с явно указанной веткой собираем локально.
USE_BUILD=0
if [ "$FORCE_BUILD" -eq 1 ]; then
    USE_BUILD=1
elif [ "$FORCE_PULL" -eq 0 ] && [ "$BRANCH" != "master" ] && [ "$BRANCH" != "dev" ] && [ "$BRANCH" != "$DEFAULT_BRANCH" ]; then
    USE_BUILD=1
    echo -e "${YELLOW}  Ветка ${BRANCH} не публикуется в GHCR — собираем образ локально${NC}"
fi

if [ "$USE_BUILD" -eq 1 ]; then
    docker compose build
elif docker compose pull 2>/dev/null; then
    echo -e "  ${GREEN}Образ загружен из GHCR${NC}"
else
    echo -e "${YELLOW}  Не удалось загрузить образ, собираем локально...${NC}"
    docker compose build
fi
docker compose up -d

# Проверяем что контейнер запустился
if ! docker ps --format '{{.Names}}' | grep -q 'mtproto-service-node'; then
    echo -e "${RED}Ошибка: контейнер сервис-ноды не запустился!${NC}"
    echo -e "Проверьте логи: docker compose logs"
    exit 1
fi

# Ждём пока API поднимется и фоновая инициализация начнётся
echo -e "  Ожидание запуска API сервис-ноды..."
READY=0
for _ in $(seq 1 30); do
    if curl -fsS "${API_URL}/api/health" >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 2
done

if [ "$READY" -ne 1 ]; then
    echo -e "${RED}Ошибка: API сервис-ноды не отвечает.${NC}"
    echo -e "Проверьте логи: docker compose logs"
    exit 1
fi

# Если были запущенные прокси, дожидаемся готовности proxy image.
# Иначе восстановление может попасть в гонку с фоновым bootstrap внутри ноды.
if [ -n "$RUNNING_PROXIES" ]; then
    echo -e "  Ожидание готовности образа telemt-proxy-v4..."
    IMAGE_READY=0
    for _ in $(seq 1 60); do
        if docker image inspect telemt-proxy-v4 >/dev/null 2>&1; then
            IMAGE_READY=1
            break
        fi
        sleep 2
    done

    if [ "$IMAGE_READY" -ne 1 ]; then
        echo -e "${RED}Ошибка: образ telemt-proxy-v4 не был собран вовремя.${NC}"
        echo -e "Проверьте логи: docker compose logs"
        exit 1
    fi
fi

echo -e "${CYAN}[5/5] Восстановление прокси...${NC}"

# Сервис-нода при запуске автоматически НЕ поднимает контейнеры прокси.
# Но данные о них хранятся в ./data/proxies.json.
# Нужно попросить ноду восстановить все прокси через API.

# Читаем токен из .env
AUTH_TOKEN=$(grep '^AUTH_TOKEN=' .env | cut -d'=' -f2)

# Получаем список прокси из API и запускаем остановленные
PROXIES_RESPONSE=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "${API_URL}/api/proxies" 2>/dev/null || echo "[]")

if [ "$PROXIES_RESPONSE" != "[]" ] && [ -n "$PROXIES_RESPONSE" ]; then
    # Парсим ID прокси
    PROXY_IDS=$(echo "$PROXIES_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$PROXY_IDS" ]; then
        RESTORED=0
        FAILED=0
        for PROXY_ID in $PROXY_IDS; do
            # Получаем статус прокси
            STATUS_RESPONSE=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
                "${API_URL}/api/proxies/${PROXY_ID}" 2>/dev/null || echo "{}")

            STATUS=$(echo "$STATUS_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

            if [ "$STATUS" != "running" ]; then
                # Пересоздаём контейнер прокси через restart endpoint.
                # После обновления нода может ещё завершать bootstrap, поэтому делаем несколько попыток.
                RESULT="000"
                for _ in $(seq 1 5); do
                    RESULT=$(curl -s -w "%{http_code}" -o /dev/null \
                        -X POST \
                        -H "Authorization: Bearer ${AUTH_TOKEN}" \
                        -H "Content-Type: application/json" \
                        "${API_URL}/api/proxies/${PROXY_ID}/restart" 2>/dev/null || echo "000")
                    if [ "$RESULT" = "200" ]; then
                        break
                    fi
                    sleep 3
                done

                if [ "$RESULT" = "200" ]; then
                    RESTORED=$((RESTORED + 1))
                else
                    FAILED=$((FAILED + 1))
                    echo -e "  ${RED}Не удалось запустить прокси ${PROXY_ID}${NC}"
                fi
            else
                RESTORED=$((RESTORED + 1))
            fi
        done
        echo -e "  Восстановлено прокси: ${GREEN}${RESTORED}${NC}"
        if [ "$FAILED" -gt 0 ]; then
            echo -e "  ${RED}Не удалось восстановить: ${FAILED}${NC}"
        fi
    fi
else
    echo -e "  Прокси для восстановления не найдены"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Обновление завершено!                 ${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "  Версия: $(git log --oneline -1)"
echo -e "${GREEN}========================================${NC}"
