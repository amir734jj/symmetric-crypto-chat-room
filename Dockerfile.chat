FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src

COPY API/API.csproj API/
COPY Domainlogic/Domainlogic.csproj Domainlogic/
COPY Models/Models.csproj Models/
COPY UI/UI.csproj UI/
RUN dotnet restore API/API.csproj
RUN dotnet restore UI/UI.csproj

COPY . .
RUN dotnet publish API/API.csproj -c Release -o /out/api --no-restore
RUN dotnet publish UI/UI.csproj -c Release -o /out/ui --no-restore
RUN cp -r /out/ui/wwwroot /out/api/

FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_EnableDiagnostics=0 \
    ASPNETCORE_URLS=http://+:3000

EXPOSE 3000

WORKDIR /app
COPY --from=build /out/api .
RUN mkdir -p /app/data && chown -R $APP_UID /app

ENV DATABASE_PATH=/app/data/db.litedb
USER $APP_UID

ENTRYPOINT ["dotnet", "API.dll"]
