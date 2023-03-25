FROM mcr.microsoft.com/dotnet/sdk:7.0-alpine AS build-env
WORKDIR /app

# Copy csproj and restore as distinct layers
COPY . .

WORKDIR "/app/Api"

RUN dotnet restore
RUN dotnet publish -c Release -o out

WORKDIR "/app/UI"

RUN dotnet restore
RUN dotnet publish -c Release -o out

COPY app/UI/out/wwwroot /app/Api/out

# Build runtime image
FROM mcr.microsoft.com/dotnet/aspnet:7.0-alpine

WORKDIR /app
COPY --from=build-env "/app/Api/out" .
ENTRYPOINT ["dotnet", "API.dll"]