import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(
        private configService: ConfigService,
        private prisma: PrismaService
    ) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<string>('JWT_SECRET') || 'aminov',
        });
    }

    async validate(payload: any) {
        if (payload.role === 'MARKETING') {
            const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
            if (!user) {
                throw new UnauthorizedException('User not found');
            }

            const now = new Date();
            const currentTime = now.getHours() * 60 + now.getMinutes();

            if (user.workStartTime && user.workEndTime) {
                const [startHours, startMinutes] = user.workStartTime.split(':').map(Number);
                const startTime = startHours * 60 + startMinutes;

                const [endHours, endMinutes] = user.workEndTime.split(':').map(Number);
                const endTime = endHours * 60 + endMinutes;

                if (currentTime < startTime || currentTime > endTime) {
                    throw new UnauthorizedException('You can only access this resource during your work hours.');
                }
            }
        }
        return { userId: payload.sub, username: payload.username, role: payload.role };
    }
} 