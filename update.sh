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
for arg in "$@"; do
    case "$arg" in
        --b=*) FORCE_BRANCH="${arg#--b=}" ;;
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

# Порт API берём из .env: compose публикует именно его, а проверка готовности
# ниже раньше использовала дефолт 8443 и на ноде с другим PORT не проходила
# никогда — обновление завершалось ошибкой при полностью исправной ноде.
PORT=$(grep '^PORT=' .env | cut -d'=' -f2)
PORT=${PORT:-8443}

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
if [ -n "$FORCE_BRANCH" ]; then
    BRANCH="$FORCE_BRANCH"
else
    BRANCH=$(git remote show origin 2>/dev/null | grep 'HEAD branch' | awk '{print $NF}')
    BRANCH=${BRANCH:-master}
fi
echo -e "  Ветка: ${YELLOW}${BRANCH}${NC}"

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
git stash pop 2>/dev/null || true

echo -e "${CYAN}[4/5] Загрузка и запуск обновлённой сервис-ноды...${NC}"
export COMPOSE_PROJECT_NAME=mtproto-node
docker network create mtproto-net 2>/dev/null || true

echo -e "  Загрузка образа из GHCR..."
if docker compose pull 2>/dev/null; then
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
    if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
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
PROXIES_RESPONSE=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" "http://localhost:${PORT}/api/proxies" 2>/dev/null || echo "[]")

if [ "$PROXIES_RESPONSE" != "[]" ] && [ -n "$PROXIES_RESPONSE" ]; then
    # Парсим ID прокси
    PROXY_IDS=$(echo "$PROXIES_RESPONSE" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$PROXY_IDS" ]; then
        RESTORED=0
        FAILED=0
        for PROXY_ID in $PROXY_IDS; do
            # Получаем статус прокси
            STATUS_RESPONSE=$(curl -s -H "Authorization: Bearer ${AUTH_TOKEN}" \
                "http://localhost:${PORT}/api/proxies/${PROXY_ID}" 2>/dev/null || echo "{}")

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
                        "http://localhost:${PORT}/api/proxies/${PROXY_ID}/restart" 2>/dev/null || echo "000")
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
