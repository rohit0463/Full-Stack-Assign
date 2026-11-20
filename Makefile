.PHONY: up down test build logs clean help

help:
	@echo "Available commands:"
	@echo "  make up       - Build and start all services (Backend: 8000, Frontend: 3000)"
	@echo "  make down     - Stop all running services"
	@echo "  make test     - Run backend test suite"
	@echo "  make logs     - Follow logs from running containers"
	@echo "  make clean    - Remove stopped containers and prune volumes"

up:
	docker compose up --build -d

down:
	docker compose down

test:
	cd backend && pytest -v

logs:
	docker compose logs -f

clean:
	docker compose down -v
