# TechnoLoad Platform

API REST mock de TechnoLoad para activos, mantenimiento y operaciones. Está construida con Node.js nativo y persiste los datos de demostración en `db.json`.

## API

- `GET /api/v1/health`
- CRUD en `/api/v1/assets`
- CRUD en `/api/v1/maintenance`
- CRUD en `/api/v1/operations`

## Ejecución local

```bash
npm start
```

Base URL local: `http://localhost:8080/api/v1`

## Despliegue en Azure App Service

1. Crea un repositorio llamado `technoload-platform` y sube el contenido de esta carpeta.
2. En Azure Portal, crea un recurso **App Service** con runtime **Node 18 LTS o superior** y sistema operativo Linux.
3. En **Deployment Center**, conecta el repositorio y la rama `main`.
4. Azure ejecutará `npm start`; la aplicación usa automáticamente el puerto entregado por `PORT`.
5. Comprueba la publicación en `https://TU-APP.azurewebsites.net/api/v1/health`.

## Alcance

La API incluye CORS para facilitar el consumo desde la WebApp y está pensada para demo académica. Para producción necesitaría una base de datos administrada, autenticación, autorización y persistencia no basada en archivo.
