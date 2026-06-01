FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build-env
WORKDIR /app

# Copy csproj and restore as distinct layers
COPY . .

# NuGet restore
RUN dotnet restore

WORKDIR "/app/API"

RUN dotnet publish -c Release -o out

WORKDIR "/app/UI"

RUN dotnet publish -c Release -o out

RUN cp -rpf /app/UI/out/wwwroot /app/API/out

# Build runtime image
FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine

ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_EnableDiagnostics=0 \
    ASPNETCORE_URLS=http://+:3000
EXPOSE 3000

WORKDIR /app
COPY --from=build-env "/app/API/out" .
ENTRYPOINT ["dotnet", "API.dll"]
