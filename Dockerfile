FROM mcr.microsoft.com/dotnet/sdk:7.0-alpine AS build-env
WORKDIR /app

# Copy csproj and restore as distinct layers
COPY . .

# NuGet restore
RUN dotnet restore

WORKDIR "/app/API"

RUN dotnet publish -c Release -o out

WORKDIR "/app/UI"

RUN dotnet publish -c Release -o out

RUN cp -rf /app/UI/out/wwwroot /app/API/out

# Build runtime image
FROM mcr.microsoft.com/dotnet/aspnet:7.0-alpine

WORKDIR /app
COPY --from=build-env "/app/API/out" .
ENTRYPOINT ["dotnet", "API.dll"]